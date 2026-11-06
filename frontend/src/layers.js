// The map's layers, drawn by deck.gl inside MapLibre: worked out from what App.jsx holds, each time any of it changes.
// Pure: data in, layers out. Each layer's data comes already worked out (App.jsx's useMemos), so a layer whose data
// hasn't changed costs deck.gl next to nothing.
import { PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { Charts, modelLayer } from './meshes'
import { AIDS, VESSEL_CATEGORIES, VESSEL_DOT } from './vessels'
import { WARNING_CATEGORIES, WARNING_DOT, WARNING_DOT_PICKED, WARNING_EDGE, WARNING_FILL, WARNING_FILL_PICKED } from './warnings'

export const SKYLINE_ID = 'skyline' // the map's own buildings: what deck.gl draws goes in under them
export const INLAND_WATER_ID = 'inland-water' // the charts go in under the map's own inland water
export const LIGHT_DOT = 3 // px
export const CURRENT_LABELS_ZOOM = 12 // further out, the arrows go without their speeds
export const MEASURE_RGB = [253, 224, 71]
export const ROUTE_RGB = [251, 146, 60]
export const FINDING_RGB = { danger: [248, 113, 113], caution: [252, 211, 77], info: [125, 211, 252] }
// distances as a chart gives them, and short ones in metres too; bearings true, in three figures
export const miles = (nm) => (nm < 1 ? `${nm.toFixed(2)} nm (${Math.round(nm * 1852)} m)` : `${nm.toLocaleString([], { maximumFractionDigits: nm < 100 ? 2 : 1 })} nm`)
export const trueBearing = (degrees) => `${String(Math.round(degrees) % 360).padStart(3, '0')}°T`

export function buildLayers({ data, warningSet, picked, globe, vesselModels, level, sun, vesselLift, currentSet, zoom, standing, afloat, lights, vesselDots, trackData, aheadData, vesselRoute, legs, measured, routeData, route, pickedWaypoint, findings, findingData, planEnds, fleetTrack, vesselTrack, deckSet, showing, standby, show, contours }) {
const { boxes, dots } = warningSet
  const colourOf = ({ warning }) => WARNING_CATEGORIES[warning.category]
  const boxLayer = new PolygonLayer({
    id: 'warning-boxes',
    beforeId: SKYLINE_ID,
    data: boxes,
    visible: boxes.length > 0 && !globe, // (on the globe, the dots alone: big boxes would sink into it too)
    extruded: true,
    wireframe: true,
    material: false,
    getPolygon: (box) => box.ring,
    getElevation: (box) => box.height,
    getFillColor: (box) => [...colourOf(box), box.warning === picked ? WARNING_FILL_PICKED : WARNING_FILL],
    getLineColor: (box) => [...colourOf(box), WARNING_EDGE],
    updateTriggers: { getFillColor: picked },
    // see-through boxes mustn't hide what's behind them from each other
    parameters: { depthWriteEnabled: false },
  })
  const dotLayer = new ScatterplotLayer({
    id: 'warning-dots',
    beforeId: SKYLINE_ID,
    data: dots,
    visible: dots.length > 0,
    billboard: true,
    stroked: true,
    radiusUnits: 'pixels',
    lineWidthUnits: 'pixels',
    getPosition: (dot) => dot.position,
    getRadius: (dot) => (dot.warning === picked ? WARNING_DOT_PICKED : WARNING_DOT),
    updateTriggers: { getRadius: picked },
    getFillColor: colourOf,
    getLineColor: [255, 255, 255, 220],
    getLineWidth: 1,
    // on a coast, or the land's height would cut them in half
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
  })
  const vesselLayer = modelLayer('vessels', vesselModels, level, sun, SKYLINE_ID, vesselLift)
  const currentLayer = new PathLayer({
    id: 'currents',
    beforeId: SKYLINE_ID,
    data: currentSet.lines,
    visible: currentSet.lines.length > 0,
    widthUnits: 'pixels',
    getPath: (line) => line.path,
    getWidth: 1.5,
    getColor: (line) => line.color,
    capRounded: true,
    jointRounded: true,
  })
  const currentDots = new ScatterplotLayer({
    id: 'current-slack',
    beforeId: SKYLINE_ID,
    data: currentSet.dots,
    visible: currentSet.dots.length > 0,
    radiusUnits: 'pixels',
    getPosition: (dot) => dot.position,
    getRadius: 2,
    getFillColor: (dot) => dot.color,
  })
  const currentLabels = new TextLayer({
    id: 'current-labels',
    beforeId: SKYLINE_ID,
    data: currentSet.labels,
    visible: zoom >= CURRENT_LABELS_ZOOM && currentSet.labels.length > 0,
    getPosition: (label) => label.position,
    getText: (label) => label.text,
    getSize: 10,
    getColor: [203, 213, 225, 200],
    getPixelOffset: [0, 12],
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
  })
  const objectLayers = [
    ...standing.map((set) => modelLayer(`objects-standing-${set.id}`, set, level, sun, SKYLINE_ID)),
    ...afloat.map((set) => modelLayer(`objects-afloat-${set.id}`, set, level, sun, SKYLINE_ID, level)),
  ]
  const lightLayer = new ScatterplotLayer({
    id: 'lights',
    beforeId: SKYLINE_ID,
    data: lights,
    visible: lights.length > 0,
    billboard: true,
    radiusUnits: 'pixels',
    getPosition: (light) => light.position,
    getRadius: LIGHT_DOT,
    getFillColor: (light) => light.color,
    parameters: { depthWriteEnabled: false },
  })
  const vesselDotLayer = new ScatterplotLayer({
    id: 'vessel-dots',
    beforeId: SKYLINE_ID,
    data: vesselDots,
    visible: vesselDots.length > 0,
    radiusUnits: 'pixels',
    getPosition: (dot) => [dot.lng, dot.lat],
    getRadius: VESSEL_DOT,
    getFillColor: VESSEL_CATEGORIES[AIDS],
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
  })
  const trackLayer = new PathLayer({
    id: 'vessel-track',
    beforeId: SKYLINE_ID,
    data: trackData,
    visible: !!vesselTrack,
    widthUnits: 'pixels',
    getPath: (path) => path,
    getWidth: 2,
    getColor: [255, 255, 255, 170],
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
  })
  // the predicted route ahead, in the colour of the track behind but fainter, with a mark every so many hours
  const ahead = aheadData
  const routeLayer = new PathLayer({
    id: 'vessel-route',
    beforeId: SKYLINE_ID,
    data: ahead,
    visible: ahead.length > 0,
    widthUnits: 'pixels',
    getPath: (path) => path,
    getWidth: 2,
    getColor: [103, 232, 249, 150],
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
  })
  const ticks = vesselRoute?.ticks ?? []
  const tickLayer = new ScatterplotLayer({
    id: 'vessel-route-ticks',
    beforeId: SKYLINE_ID,
    data: ticks,
    visible: ticks.length > 0,
    radiusUnits: 'pixels',
    getPosition: (tick) => tick.position,
    getRadius: 3,
    getFillColor: [103, 232, 249, 220],
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
  })
  const tickLabels = new TextLayer({
    id: 'vessel-route-labels',
    beforeId: SKYLINE_ID,
    data: ticks,
    visible: ticks.length > 0,
    getPosition: (tick) => tick.position,
    getText: (tick) => (tick.hours % 24 ? `+${tick.hours} h` : `day ${tick.hours / 24}`),
    getSize: 11,
    getColor: [207, 250, 254],
    getPixelOffset: [0, -12],
    background: true,
    getBackgroundColor: [15, 23, 42, 190],
    backgroundPadding: [3, 1],
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
  })
  const measureLegs = new PathLayer({
    id: 'measure-legs',
    data: legs,
    visible: legs.length > 0,
    widthUnits: 'pixels',
    getPath: (leg) => [leg.from, leg.to],
    getWidth: 2,
    getColor: (leg) => [...MEASURE_RGB, leg.live ? 150 : 255],
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
  })
  const measurePoints = new ScatterplotLayer({
    id: 'measure-points',
    data: measured,
    visible: measured.length > 0,
    radiusUnits: 'pixels',
    lineWidthUnits: 'pixels',
    stroked: true,
    getPosition: (point) => point,
    getRadius: 4,
    getFillColor: MEASURE_RGB,
    getLineColor: [15, 23, 42],
    getLineWidth: 1.5,
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
  })
  const routePaths = new PathLayer({
    id: 'route-legs',
    data: routeData.paths,
    visible: route.waypoints.length > 1,
    getPath: (path) => path,
    getWidth: 3,
    widthUnits: 'pixels',
    getColor: [...ROUTE_RGB, 235],
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
  })
  const routePoints = new ScatterplotLayer({
    id: 'route-waypoints',
    data: routeData.waypoints,
    visible: route.waypoints.length > 0,
    radiusUnits: 'pixels',
    getPosition: (w) => [w.lng, w.lat],
    getRadius: (w) => (w.i === pickedWaypoint ? 7 : 5),
    getFillColor: (w) => (w.i === pickedWaypoint ? ROUTE_RGB : [15, 23, 42]),
    getLineColor: ROUTE_RGB,
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: 2,
    updateTriggers: { getRadius: pickedWaypoint, getFillColor: pickedWaypoint },
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
  })
  const routeLabels = new TextLayer({
    id: 'route-labels',
    data: zoom >= 7 ? routeData.names.concat(routeData.legLabels) : routeData.names,
    visible: route.waypoints.length > 0,
    getPosition: (label) => label.position,
    getText: (label) => label.text,
    getSize: (label) => label.size,
    getColor: [254, 215, 170, 235],
    getPixelOffset: (label) => label.offset,
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
  })
  const findingDots = new ScatterplotLayer({
    id: 'route-findings',
    data: findingData,
    visible: !!findings?.length || planEnds.length > 0,
    radiusUnits: 'pixels',
    getPosition: (f) => f.position,
    getRadius: 5,
    getFillColor: (f) => [...f.color, 230],
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
  })
  const measureLabels = new TextLayer({
    id: 'measure-labels',
    data: legs,
    visible: legs.length > 0,
    getPosition: (leg) => [(leg.from[0] + leg.to[0]) / 2, (leg.from[1] + leg.to[1]) / 2],
    getText: (leg) => `${miles(leg.nm)}  ${trueBearing(leg.bearing)}`,
    characterSet: 'auto', // (its default letters have no degree sign)
    getSize: 12,
    getColor: [254, 249, 195],
    background: true,
    getBackgroundColor: [15, 23, 42, 210],
    backgroundPadding: [4, 2],
    getPixelOffset: [0, -12],
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
  })
  // a fleet vessel's recorded track, from the Fleet tab
  const fleetTrackLayer = new PathLayer({
    id: 'fleet-track',
    beforeId: SKYLINE_ID,
    data: fleetTrack?.pieces ?? [],
    visible: !!fleetTrack,
    widthUnits: 'pixels',
    getPath: (piece) => piece.map(([lng, lat]) => [lng, lat]),
    getWidth: 2,
    getColor: [196, 181, 253, 220],
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
  })
  return [
      new Charts({ id: 'charts', beforeId: INLAND_WATER_ID, visible: !globe, data, showing, standby, show, zoom, level, contours, sun }),
      boxLayer,
      dotLayer,
      ...objectLayers,
      modelLayer('bridge-decks', deckSet, level, sun, SKYLINE_ID),
      lightLayer,
      currentLayer,
      currentDots,
      currentLabels,
      trackLayer,
      routeLayer,
      tickLayer,
      tickLabels,
      vesselLayer,
      vesselDotLayer,
      fleetTrackLayer,
      measureLegs,
      measurePoints,
      measureLabels,
      routePaths,
      findingDots,
      routePoints,
      routeLabels,
    ].filter(Boolean)
}
