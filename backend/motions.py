"""How a vessel will move in a forecast sea: roll, pitch and heave, the accelerations they give at any point aboard,
and the dangers of synchronous and parametric roll. A planning estimate from standard methods, not a seakeeping
analysis of the ship: its own response would need its hull's hydrodynamics, which her documents don't carry.

The sea: each component (the wind's sea and the swell) a two-parameter (Bretschneider / ITTC) spectrum from its
significant height Hs and period, S(ω) = 5/16 · Hs² · ωp⁴/ω⁵ · exp(−5/4 · (ωp/ω)⁴). Met in a vessel making U knots
at an angle μ to the waves' travel, a wave of frequency ω is met at ωe = |ω − ω²·U·cos μ / g|.

Roll: one degree of freedom, excited by the wave slope across the vessel, ζk·sin μ, reduced for waves short against
her draught, with a natural period from her GM (IS Code 2.3.4: T = 2·C·B/√GM) and a damping ratio of ROLL_DAMPING:
RAO = κ·|sin μ| / √((1 − r²)² + (2ζr)²), r = ωe/ωn. Heave follows the wave for long waves and less for short ones;
pitch, the wave slope along her, less as waves shorten against her length. Accelerations from them at a point
(x from the LCF, y off the centreline, z above the roll centre), with gravity's share as she rolls.

Results are significant values (the mean of the highest third); the greatest to expect in a few hours is about
MOST_EXPECTED times that. Synchronous roll: met wave period near the roll period in seas from the beam; parametric:
near half of it, in head or following seas of about her length (IMO MSC.1/Circ.1228's guidance)."""
import math

import numpy as np

G = 9.81
ROLL_DAMPING = 0.06  # of critical: a bare hull with bilge keels, about
HEAVE_DAMPING = 0.25
MOST_EXPECTED = 1.86  # greatest of ~1000 oscillations over a significant value, Rayleigh
OMEGA = np.linspace(0.15, 3.0, 220)  # rad/s, the wave frequencies summed over
KNOT = 0.5144  # m/s


def spectrum(hs: float, period: float, mean_period: bool = True) -> np.ndarray:
    """S(ω) for a sea of significant height hs (m) and period (s): a mean period (as forecasts give) is taken as
    0.77 of the peak's."""
    if not hs or not period or hs <= 0 or period <= 0:
        return np.zeros_like(OMEGA)
    tp = period / 0.77 if mean_period else period
    wp = 2 * math.pi / tp
    return 5 / 16 * hs ** 2 * wp ** 4 / OMEGA ** 5 * np.exp(-1.25 * (wp / OMEGA) ** 4)


def particulars(ship: dict):
    """What the responses need of a ship: (LBP, beam, draught, roll period, roll's natural frequency)."""
    lbp, beam, draught = ship["lbp"], ship["beam"], max(ship["draught"], 0.5)
    gm = max(ship.get("gm") or 0.05, 0.05)
    tr = ship.get("roll_period") or 2 * (0.373 + 0.023 * beam / draught - 0.043 * lbp / 100) * beam / math.sqrt(gm)
    return lbp, beam, draught, tr, 2 * math.pi / tr


def raos(ship: dict, mu: float, u: float):
    """At each of OMEGA, met by her at angle mu (rad, 0 following) and u m/s: the met frequency, and roll (rad per m
    of wave), pitch (rad per m) and heave (m per m)."""
    lbp, beam, draught, tr, wn = particulars(ship)
    k = OMEGA ** 2 / G  # wave number, deep water
    we = np.abs(OMEGA - OMEGA ** 2 * u * math.cos(mu) / G) + 1e-6
    # roll: the slope across her, less for waves short against her draught
    kappa = np.exp(-0.5 * k * draught)
    r = we / wn
    roll_rao = kappa * abs(math.sin(mu)) * k / np.sqrt((1 - r ** 2) ** 2 + (2 * ROLL_DAMPING * r) ** 2)
    # heave: with the wave when long; pitch: the slope along her, less as waves shorten against her length
    # (waves short against her length, as she meets them, average out along her: about 0.7 of the slope kept
    # when the wavelength is her length, a quarter at half of it, nearly all for a long swell)
    wavelength = 2 * math.pi / k
    seen_length = lbp * max(abs(math.cos(mu)), 0.15)
    pitch_cut = 1 / (1 + 0.7 * (seen_length / wavelength) ** 2)
    heave_cut = 1 / (1 + 0.35 * (seen_length / wavelength) ** 2)
    wh = math.sqrt(G / (draught * 2.0))  # heave's natural frequency, its added mass about its own
    rh = we / wh
    heave_rao = np.minimum(heave_cut / np.sqrt((1 - rh ** 2) ** 2 + (2 * HEAVE_DAMPING * rh) ** 2), 1.5)
    pitch_rao = k * abs(math.cos(mu)) * pitch_cut
    return we, roll_rao, pitch_rao, heave_rao


def components(ship: dict, heading: float, knots: float, sea: list, per: int = 8) -> list:
    """The sea as a few waves to draw her moving in: each sea component split into `per` bands of equal energy,
    each band a wave of its own: {amp m, omega, omega_e (met, signed: < 0 overtaking her), k, mu ° (its travel
    against her heading, + to starboard of the bow), roll rad, pitch rad, heave m (her response's amplitude)}."""
    out = []
    u = max(knots, 0.0) * KNOT
    for hs, period, wave_from in sea:
        s = spectrum(hs, period)
        if not s.any():
            continue
        mu = math.radians((wave_from + 180 - heading) % 360)
        we, roll_rao, pitch_rao, heave_rao = raos(ship, mu, u)
        energy = np.cumsum(s)
        m0 = float(energy[-1] * (OMEGA[1] - OMEGA[0]))
        for i in range(per):
            j = int(np.searchsorted(energy, energy[-1] * (i + 0.5) / per))
            w = float(OMEGA[j])
            amp = math.sqrt(2 * m0 / per)
            out.append({"amp": round(amp, 3), "omega": round(w, 4), "omega_e": round(w - w * w * u * math.cos(mu) / G, 4),
                        "k": round(w * w / G, 5), "mu": round(math.degrees(mu), 1),
                        "roll": round(float(roll_rao[j]) * amp, 4), "pitch": round(float(pitch_rao[j]) * amp, 4),
                        "heave": round(float(heave_rao[j]) * amp, 3)})
    return out


def respond(ship: dict, heading: float, knots: float, sea: list) -> dict:
    """The vessel's motions on a heading (° true) at a speed in the given sea components [(hs, period, from °)].
    ship: {lbp, beam, draught, gm, kg, roll_period?, cb?}. Significant amplitudes: roll and pitch in degrees, heave in
    m; their accelerations' spectral moments are kept for reading at points aboard (accelerations())."""
    lbp, beam, draught, tr, wn = particulars(ship)
    u = max(knots, 0.0) * KNOT
    m = {k: 0.0 for k in ("roll", "pitch", "heave", "roll_acc", "pitch_acc", "heave_acc")}
    dw = OMEGA[1] - OMEGA[0]
    worst = {"synchronous": 0.0, "parametric": 0.0}
    for hs, period, wave_from in sea:
        s = spectrum(hs, period)
        if not s.any():
            continue
        mu = math.radians((wave_from + 180 - heading) % 360)  # the waves' travel against her heading: 0 following
        we, roll_rao, pitch_rao, heave_rao = raos(ship, mu, u)
        for name, rao in (("roll", roll_rao), ("pitch", pitch_rao), ("heave", heave_rao)):
            resp = rao ** 2 * s
            m[name] += float(np.sum(resp) * dw)
            m[f"{name}_acc"] += float(np.sum(resp * we ** 4) * dw)
        # the met period against her roll period, where this component's energy is
        if s.sum() > 0:
            te = 2 * math.pi / float(we[int(np.argmax(s))])  # (at the sea's peak, where resonance would build)
            beam_share, end_share = abs(math.sin(mu)), abs(math.cos(mu))
            wavelength = G * (period / 0.77) ** 2 / (2 * math.pi)
            if 0.8 <= te / tr <= 1.25 and beam_share > 0.5 and hs > 1:
                worst["synchronous"] = max(worst["synchronous"], hs)
            if 0.4 <= te / tr <= 0.6 and end_share > 0.7 and 0.6 * lbp <= wavelength <= 2.5 * lbp and hs > 1.5:
                worst["parametric"] = max(worst["parametric"], hs)
    sig = lambda v: 2 * math.sqrt(max(v, 0.0))
    warnings = []
    if worst["synchronous"]:
        warnings.append(f"Synchronous roll risk: beam seas, encounter period near {tr:.0f} s roll period")
    if worst["parametric"]:
        warnings.append(f"Parametric roll risk: head or following seas, encounter period near half the roll period")
    return {
        "roll": math.degrees(sig(m["roll"])), "pitch": math.degrees(sig(m["pitch"])), "heave": sig(m["heave"]),
        "roll_period": tr, "moments": {k_: m[k_] for k_ in ("roll", "roll_acc", "pitch_acc", "heave_acc")},
        "warnings": warnings,
    }


def accelerations(motion: dict, x: float, y: float, z: float) -> dict:
    """Significant accelerations (in g) at a point x m forward of the LCF, y m off the centreline, z m above the roll
    centre (about the waterline): vertical from heave, pitch and roll; transverse from roll and gravity's share as she
    leans; longitudinal from pitch."""
    mm = motion["moments"]
    sig = lambda v: 2 * math.sqrt(max(v, 0.0))
    vertical = math.sqrt(mm["heave_acc"] + mm["pitch_acc"] * x ** 2 + mm["roll_acc"] * y ** 2)
    transverse = math.sqrt(mm["roll_acc"] * z ** 2 + (G ** 2) * mm["roll"])
    longitudinal = math.sqrt(mm["pitch_acc"] * z ** 2)
    return {"vertical": sig(vertical ** 2) / G, "transverse": sig(transverse ** 2) / G, "longitudinal": sig(longitudinal ** 2) / G}


def comfort_cost(motion: dict) -> float:
    """How much worse than calm a stretch of sea is to sail, for steering round the worst: roll most of all."""
    return 1 + (motion["roll"] / 12) ** 2 + (motion["pitch"] / 4) ** 2 + 3 * len(motion["warnings"])


if __name__ == "__main__":
    ship = {"lbp": 180, "beam": 28, "draught": 9, "gm": 1.0}
    calm = respond(ship, 0, 14, [])
    assert calm["roll"] == 0 and calm["heave"] == 0
    beam = respond(ship, 0, 14, [(4.0, 9.0, 90)])
    head = respond(ship, 0, 14, [(4.0, 9.0, 0)])
    assert beam["roll"] > 3 * head["roll"], (beam["roll"], head["roll"])  # seas abeam roll her, from ahead hardly
    assert head["pitch"] > beam["pitch"], (head["pitch"], beam["pitch"])  # and pitch her more from ahead
    bigger = respond(ship, 0, 14, [(6.0, 9.0, 90)])
    assert abs(bigger["roll"] / beam["roll"] - 1.5) < 1e-6  # (linear: response grows with the height)
    a = accelerations(beam, 60, 10, 15)
    assert a["transverse"] > accelerations(beam, 0, 0, 0)["transverse"] > 0
    # her roll period met by a big swell on the beam is flagged
    sync = respond({**ship, "roll_period": 12}, 0, 0, [(3.0, 12 * 0.77, 90)])
    assert any("Synchronous" in w for w in sync["warnings"]), sync["warnings"]
    # the components: as much energy as the sea, and her roll in them about as the statistics say
    parts = components(ship, 0, 14, [(4.0, 9.0, 90)])
    assert abs(4 * math.sqrt(sum(c["amp"] ** 2 / 2 for c in parts)) - 4.0) < 0.05
    assert abs(math.degrees(math.sqrt(sum(c["roll"] ** 2 for c in parts))) * math.sqrt(2) / beam["roll"] - 1) < 0.35
    assert all(abs(c["mu"] - 270) < 1e-6 for c in parts)  # (from the east, heading north: travelling across to port)
    print("ok", round(beam["roll"], 1), "° roll abeam,", round(head["pitch"], 1), "° pitch ahead")
