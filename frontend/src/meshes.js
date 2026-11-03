// The compiled charts as deck.gl meshes: their shaders (tide, daylight, ECDIS depth colours) and one layer for them all
import { COORDINATE_SYSTEM, CompositeLayer, Layer, project32 } from '@deck.gl/core'
import { Geometry, Model } from '@luma.gl/engine'
import { SOFTWARE } from './geo'

const OUTLINE_ZOOM = 8 // closer than this, the charts' coasts take over from the world's outline

// true to scale, walls are too small to see from further out than this
const LAND_WALLS_ZOOM = SOFTWARE ? 11.5 : 10

// the open sea wherever no chart is, far below everything, only so that night can fall on it too
function worldSea() {
  const lons = Array.from({ length: 109 }, (_, i) => -540 + i * 10)
  const lats = Array.from({ length: 35 }, (_, i) => -85 + i * 5)
  const positions = new Float32Array(lons.flatMap((lon) => lats.flatMap((lat) => [lon, lat, -11000])))
  const colors = new Uint8Array(lons.length * lats.length * 4)
  for (let i = 0; i < colors.length; i += 4) colors.set([8, 30, 66, 255], i)
  const indices = []
  for (let x = 0; x < lons.length - 1; x++) {
    for (let y = 0; y < lats.length - 1; y++) {
      const a = x * lats.length + y
      const b = a + lats.length
      indices.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  return {
    id: 'sea',
    origin: null,
    meshes: {
      waterSea: {
        attributes: { positions: { value: positions, size: 3 }, colors: { value: colors, size: 4, normalized: true } },
        indices: { value: new Uint32Array(indices), size: 1 },
      },
    },
  }
}
const WORLD_SEA = worldSea()

// a compiled chart (backend/charts.py): the arrays go straight to the graphics chip as they are
export function unpack(buffer) {
  const size = new DataView(buffer).getUint32(0, true)
  const chart = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, size)))
  let at = 4 + size
  const take = (Type, length) => {
    const array = new Type(buffer, at, length)
    at += array.byteLength
    return array
  }
  for (const [key, [vertices, indices]] of Object.entries(chart.meshes)) {
    const positions = { value: take(Float32Array, vertices * 3), size: 3 }
    const colors = { value: take(Uint8Array, vertices * 4), size: 4, normalized: true }
    const value = take(Uint32Array, indices)
    chart.meshes[key] = vertices && { attributes: { positions, colors }, indices: { value, size: 1 } }
  }
  return chart
}

// The tide is just one number for the shader, so scrubbing through it costs next to nothing, and there's no sheet of
// water over everything to fight the seabed for pixels. Seabed above the water dries out; land below it gets wet.
const TIDE_UNIFORMS = `layout(std140) uniform tideUniforms {
  float level;
  float seabed;
  float contours;
  float shallow;
  float safety;
  float deep;
  float originX;
  float originY;
  float sunLat;
  float sunLon;
  float lit;
  float behind;
} tide;`
const tideModule = {
  name: 'tide',
  vs: TIDE_UNIFORMS,
  fs: TIDE_UNIFORMS,
  uniformTypes: Object.fromEntries(
    'level seabed contours shallow safety deep originX originY sunLat sunLon lit behind'.split(' ').map((name) => [name, 'f32']),
  ),
}

// the least a mesh can cost to draw: colours are baked in, so there's no lighting to work out for each point and pixel
const VERTEX_SHADER = `#version 300 es
in vec3 positions;
in vec4 colors;
out vec3 color;
out float height;
out float sunUp;
const float RADIANS = 0.01745329;
void main() {
  color = colors.rgb;
  height = positions.z;
  // worked out at each corner, as a CPU can't afford this per pixel. It runs true across even a huge triangle, unlike
  // the twilight curve, which the pixels do for themselves
  float lat = (tide.originY + positions.y) * RADIANS;
  float lon = (tide.originX + positions.x - tide.sunLon) * RADIANS;
  float sun = tide.sunLat * RADIANS;
  sunUp = sin(lat) * sin(sun) + cos(lat) * cos(sun) * cos(lon);
  gl_Position = project_position_to_clipspace(positions, vec3(0.0), vec3(0.0));
  // squeezed into the far end of the depth range, in order: anything a chart draws is in front of all of this, however
  // deep, so a chart overwrites the world's seabed wherever it reaches, without either being cut to fit. Behind all of
  // that goes the plain sea: from far out, a depth buffer can't tell it from the seabed by how far down it is
  if (tide.behind > 1.5) gl_Position.z = gl_Position.w * 0.99999;
  else if (tide.behind > 0.5) gl_Position.z = gl_Position.z * 0.0001 + gl_Position.w * 0.9998;
}`
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 color;
in float height;
in float sunUp;
out vec4 fragColor;
const vec3 DRY = vec3(0.52, 0.46, 0.33);
const vec3 WET = vec3(0.12, 0.38, 0.50);
const vec3 NIGHT = vec3(0.34, 0.40, 0.58);
// an ECDIS's daytime depth colours, and its contour lines
const vec3 DRYING = vec3(0.60, 0.68, 0.47);
const vec3 VERY_SHALLOW = vec3(0.45, 0.71, 0.94);
const vec3 MEDIUM_SHALLOW = vec3(0.60, 0.77, 0.95);
const vec3 MEDIUM_DEEP = vec3(0.73, 0.84, 0.88);
const vec3 DEEP = vec3(0.83, 0.92, 0.93);
const vec3 LINE = vec3(0.30, 0.36, 0.42);
const vec3 SAFETY_LINE = vec3(0.07, 0.10, 0.14);
// how much of a pixel a contour line covers: soft-edged, or a line this thin would sparkle as the view turns
float line(float depth, float contour, float pixel, float width) {
  return clamp(width + 0.5 - abs(depth - contour) / pixel, 0.0, 1.0);
}
void main() {
  vec3 c = color;
  if (tide.seabed > 0.5) {
    if (tide.contours > 0.5) {
      // (a hair off: seabed lying flat at exactly a contour's depth would otherwise be all line)
      float depth = -height - 0.01;
      if (tide.contours > 1.5) {
        c = height > 0.0 ? DRYING
          : depth < tide.shallow ? VERY_SHALLOW
          : depth < tide.safety ? MEDIUM_SHALLOW
          : depth < tide.deep ? MEDIUM_DEEP
          : DEEP;
      }
      if (tide.contours < 2.5) {
        float pixel = max(fwidth(depth), 0.0001);
        // where one pixel spans more depth than that, as rough seabed does from far out, a line would fill the pixel
        float clear = 1.0 - smoothstep(20.0, 60.0, pixel);
        c = mix(c, LINE, clear * max(line(depth, tide.shallow, pixel, 0.5), line(depth, tide.deep, pixel, 0.5)));
        c = mix(c, SAFETY_LINE, clear * line(depth, tide.safety, pixel, 1.0));
      }
    }
    if (height > tide.level) c = mix(c, DRY, 0.85);
  } else if (height < tide.level) {
    c = mix(c, WET, 0.75);
  }
  if (tide.lit > 0.5) c *= mix(NIGHT, vec3(1.0), smoothstep(-0.21, 0.05, sunUp));
  fragColor = vec4(c, 1.0);
}`

class Mesh extends Layer {
  initializeState() {}

  updateState({ props, oldProps }) {
    if (props.mesh === oldProps.mesh) return
    this.state.model?.destroy()
    this.state.model = new Model(this.context.device, {
      ...this.getShaders({ vs: VERTEX_SHADER, fs: FRAGMENT_SHADER, modules: [project32, tideModule] }),
      id: props.id,
      geometry: new Geometry({ topology: props.topology, ...props.mesh }),
      bufferLayout: this.getAttributeManager().getBufferLayouts(),
      parameters: { depthWriteEnabled: true, depthCompare: 'less-equal' },
    })
  }

  draw() {
    const { model } = this.state
    const { level, seabed, behind, contours, sun, coordinateOrigin } = this.props
    const [originX, originY] = coordinateOrigin
    const tide = { level, seabed: seabed ? 1 : 0, behind, ...contours, ...sun, originX, originY }
    model.shaderInputs.setProps({ tide })
    model.draw(this.context.renderPass)
  }

  finalizeState(context) {
    super.finalizeState(context)
    this.state.model?.destroy()
  }
}
Mesh.layerName = 'Mesh'

const ONE = [{}]

function chartLayers(chart, show, zoom, level, contours, sun) {
  const mesh = (key, visible, topology = 'triangle-list') =>
    chart.meshes[key] &&
    new Mesh({
      id: `${chart.id}-${key}`,
      data: ONE,
      mesh: chart.meshes[key],
      visible,
      topology,
      level,
      // walls take the depth colours but no lines: a chart's edge hangs through every depth, and would draw them all
      contours:
        key === 'water' || key === 'waterBase'
          ? contours
          : { ...contours, contours: key === 'waterWalls' && contours.contours === 2 ? 3 : 0 },
      sun,
      seabed: key.startsWith('water'),
      behind: { waterBase: 1, waterSea: 2 }[key] ?? 0,
      // (the world as a whole is too big to be offsets from anywhere)
      coordinateSystem: chart.origin ? COORDINATE_SYSTEM.LNGLAT_OFFSETS : COORDINATE_SYSTEM.LNGLAT,
      coordinateOrigin: chart.origin ? [...chart.origin, 0] : [0, 0, 0],
      // later charts win any tie while they swap, but only just: a big offset would lift them through neighbours
      getPolygonOffset: ({ layerIndex }) => [0, -layerIndex],
    })
  return [
    mesh('waterSea', true),
    mesh('waterBase', show.depare),
    mesh('water', show.depare),
    mesh('waterWalls', show.depare),
    mesh('land', show.lndare),
    mesh('landWalls', show.lndare && zoom >= LAND_WALLS_ZOOM),
    mesh('coast', show.lndare && zoom < OUTLINE_ZOOM, 'line-list'),
    mesh('outline', show.lndare && zoom >= OUTLINE_ZOOM, 'line-list'),
  ]
}

// models of chart objects or vessels (models.js), drawn just as the charts are, so the tide and the night reach them
const NO_CONTOURS = { contours: 0, shallow: 0, safety: 0, deep: 0 }
export function modelLayer(id, { mesh, origin }, level, sun, beforeId) {
  return (
    mesh &&
    new Mesh({
      id,
      beforeId,
      data: ONE,
      mesh,
      topology: 'triangle-list',
      level,
      contours: NO_CONTOURS,
      sun,
      seabed: false,
      behind: 0,
      coordinateSystem: COORDINATE_SYSTEM.LNGLAT_OFFSETS,
      coordinateOrigin: [...origin, 0],
    })
  )
}

// one layer to MapLibre, however many charts are showing
export class Charts extends CompositeLayer {
  renderLayers() {
    const { data, show, zoom, level, contours, sun } = this.props
    // the sea last, as all but what no chart covers is hidden, and hidden costs a CPU nothing
    const all = sun.lit ? [...data, WORLD_SEA] : data
    return all.flatMap((chart) => chartLayers(chart, show, zoom, level, contours, sun))
  }
}
Charts.layerName = 'Charts'
