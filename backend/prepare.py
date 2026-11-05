"""Gets everything the viewer can show ready before it's asked for, so zooming and panning never wait on it.

Run from the project folder (the installer does): backend/.venv/Scripts/python backend/prepare.py [--fine]

1. NOAA's charts: downloaded, kept up to date, and compiled at every level of detail, as the server does on its own;
   with them the world's land, coast and seabed, downloaded once.
2. The port list the route predictor and the Fleet tab use.
3. Every chart's buoys, beacons, landmarks and the like, at the zooms they show at.
4. The world's seabed, at every level but the finest, wherever there's sea.
5. The world's coast, at every level but the finest, wherever there's land.
With --fine, the finest seabed and coast too, along every coast: that's hours, and some tens of GB. Without it, those
are made as they're first seen, in under a second each.

It can be stopped and run again: whatever's done already is skipped."""
import sys
import threading
import time

import shapely

import charts
import route
import sync

FINE = "--fine" in sys.argv
COAST_TIERS = {0: (2,), 1: (3,), 2: (3, 4, 5, 6)}  # the tiers (app/tierAt) in view while each level of coast shows
OBJECT_TIERS = (5, 6)  # chart objects show from zoom 14: tiers 5 and 6
NEAR_COAST = 1.0  # degrees: the finest seabed is made this near land, with --fine


def say(text: str) -> None:
    print(text, flush=True)


def run(stage: str, jobs: list) -> None:
    """The jobs, in parallel, saying how far along they are and how long they've left."""
    if not jobs:
        say(f"{stage}: all ready")
        return
    done, failed, start = [0], [0], time.time()

    def finished(problem):
        done[0] += 1
        failed[0] += problem is not None

    def report():
        while done[0] < len(jobs):
            time.sleep(5)
            rate = done[0] / max(time.time() - start, 1)
            left = (len(jobs) - done[0]) / rate / 60 if rate else 0
            say(f"{stage}: {done[0]:,} of {len(jobs):,}" + (f", about {left:.0f} min left" if done[0] else ""))

    threading.Thread(target=report, daemon=True).start()
    sync.run_jobs(jobs, finished)
    say(f"{stage}: done, {len(jobs):,} in {(time.time() - start) / 60:.0f} min" + (f", {failed[0]} failed" if failed[0] else ""))


def tiles(kind: str, level: int, sizes: tuple, keep) -> list:
    """Every tile of a level, of those keep takes."""
    size = sizes[level]
    names = [f"{kind}_{level}_{x}_{y}" for x in range(int(360 / size)) for y in range(int(180 / size))]
    boxes = [shapely.box(*sync.tile_bounds(name, sizes)) for name in names]
    return [name for name, box in zip(names, boxes) if keep(box)]


def main() -> None:
    say("1. Charts, and the world's land, coast and seabed: downloading and preparing (the first time, hours)")
    watching = True

    def watch():
        last = None
        while watching:
            s = sync.status
            line = f"   {s['phase']}" + (f": {s['done']:,} of {s['total']:,}" if s.get("total") else "")
            if line != last:
                say(line)
                last = line
            time.sleep(10)

    threading.Thread(target=watch, daemon=True).start()
    sync.check()
    watching = False
    if sync.status.get("problem"):
        say(f"   Note: {sync.status['problem']}")
    catalog = sync.catalog

    say("2. Port list")
    say(f"   {len(route.ports()[0]):,} ports")

    jobs, seen = [], set()
    for chart in catalog.charts:
        if chart.name not in sync.on_disk:
            continue
        for tier in OBJECT_TIERS:
            if chart.band > tier:
                continue
            file = sync.objects_file(chart, tier, catalog)
            if file not in seen and not file.exists():
                seen.add(file)
                jobs.append((charts.compile_objects, sync.cell_path(chart), sync.cut_out(chart, tier, catalog), file))
    run("3. Chart objects", jobs)

    land, tree = charts.load_polygons(sync.land_source("overview"))
    shapely.prepare(land)
    all_land = shapely.union_all(land)
    shapely.prepare(all_land)
    near = shapely.buffer(all_land, NEAR_COAST) if FINE else None
    if near is not None:
        shapely.prepare(near)

    jobs = []
    for level in range(len(sync.SEA_SIZES) if FINE else len(sync.SEA_SIZES) - 1):
        finest = level == len(sync.SEA_SIZES) - 1
        keep = (lambda box: near.intersects(box) and not all_land.contains(box)) if finest else (lambda box: not all_land.contains(box))
        for name in tiles("SEA", level, sync.SEA_SIZES, keep):
            file = sync.sea_file(name)
            if not file.exists():
                jobs.append((charts.compile_sea, sync.SEA, sync.sea_bounds(name), file))
    say(f"4. Seabed: {len(jobs):,} tiles to make, about {len(jobs) * 0.21 / 1024:.1f} GB")
    run("4. Seabed", jobs)

    jobs, seen = [], set()
    for level in range(len(sync.COAST_SIZES) if FINE else len(sync.COAST_SIZES) - 1):
        for name in tiles("COAST", level, sync.COAST_SIZES, all_land.intersects):
            for tier in COAST_TIERS[level]:
                file = sync.land_file(name, tier, catalog)
                if file not in seen and not file.exists():
                    seen.add(file)
                    jobs.append(sync.land_job(name, tier, file, catalog))
    say(f"5. Coast: {len(jobs):,} tiles to make")
    run("5. Coast", jobs)

    say("Everything's ready." + ("" if FINE else " (The finest seabed and coast are made as they're first seen: add --fine to make them all now.)"))


if __name__ == "__main__":
    main()
