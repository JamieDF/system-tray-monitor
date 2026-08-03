/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * CPU temperature from /sys/class/hwmon.
 *
 * gi://GLib only, via procfs.js. See that file for why.
 */

import {listDir, readFile, readInt} from './procfs.js';
import {formatTemperature} from './units.js';

const HWMON_ROOT = '/sys/class/hwmon';

/*
 * Sensor drivers we recognise, most specific first.
 *
 * This list must stay hardware agnostic. Writing it from whatever the
 * development machine happens to expose is the obvious mistake: that machine is
 * AMD and reports k10temp, so a list of just k10temp would leave every Intel
 * user with no temperature at all and no clue why.
 *
 * Order is priority, not preference. A dedicated CPU driver reports the die
 * temperature; acpitz is a motherboard thermal zone that may be measuring
 * something else entirely and is only a last resort.
 */
const CPU_SENSORS = [
    'coretemp',   // Intel
    'k10temp',    // AMD, family 10h onward
    'zenpower',   // AMD, third party driver some users prefer over k10temp
];

const FALLBACK_SENSORS = [
    'acpitz',     // generic ACPI thermal zone
    'thinkpad',   // ThinkPad embedded controller
];

/** Priority-ordered list of every driver we will accept. */
export const SENSOR_PRIORITY = [...CPU_SENSORS, ...FALLBACK_SENSORS];

/**
 * Picks the best sensor from a set of discovered hwmon devices.
 *
 * @param {Array<{name: string, path: string}>} entries - discovered devices
 * @returns {{name: string, path: string}|null} the best match, or null
 */
export function selectSensor(entries) {
    if (!Array.isArray(entries))
        return null;

    for (const wanted of SENSOR_PRIORITY) {
        const match = entries.find(entry => entry.name === wanted);
        if (match)
            return match;
    }

    return null;
}

/**
 * Converts a raw hwmon reading to degrees Celsius.
 *
 * hwmon reports millidegrees. A plausibility check rejects obviously wrong
 * values rather than displaying them: some drivers return 0 or a sentinel when
 * a sensor is present but not yet initialised, and a panel confidently showing
 * 0 °C is worse than one showing a placeholder.
 *
 * @param {number|null} millidegrees - raw value from temp*_input
 * @returns {number|null} degrees Celsius, or null if implausible
 */
export function millidegreesToCelsius(millidegrees) {
    if (millidegrees === null || millidegrees === undefined ||
        !Number.isFinite(millidegrees))
        return null;

    const celsius = millidegrees / 1000;

    // Nothing running Linux is below freezing or above the point where silicon
    // has already shut itself down.
    if (celsius <= 0 || celsius > 150)
        return null;

    return celsius;
}

/*
 * The range a temperature gauge spans.
 *
 * Not 0 to 150. A gauge scaled over a range nothing ever reaches spends its
 * life barely moving, which tells the user nothing. Silicon idles around 40 and
 * throttles somewhere near 95, so those bounds put the interesting band across
 * the full sweep of the ring.
 */
export const TEMPERATURE_RANGE = Object.freeze({min: 30, max: 95});

/**
 * Maps a temperature onto a 0 to 1 gauge position.
 *
 * @param {number|null} celsius - temperature
 * @returns {number|null} 0 to 1, or null if not known
 */
export function temperatureFraction(celsius) {
    if (celsius === null || celsius === undefined || !Number.isFinite(celsius))
        return null;

    const {min, max} = TEMPERATURE_RANGE;
    const position = (celsius - min) / (max - min);

    return Math.min(1, Math.max(0, position));
}

/**
 * Discovers hwmon devices and their driver names.
 *
 * Devices are found by reading each one's name file, never by index.
 * /sys/class/hwmon/hwmonN numbering is not stable across reboots, so hardcoding
 * hwmon3 works until the day a driver loads in a different order and the panel
 * silently starts reporting the wifi card's temperature as the CPU's.
 *
 * @returns {Array<{name: string, path: string}>} discovered devices
 */
export function discoverSensors() {
    const entries = [];

    for (const dir of listDir(HWMON_ROOT)) {
        if (!dir.startsWith('hwmon'))
            continue;

        const path = `${HWMON_ROOT}/${dir}`;
        const name = readFile(`${path}/name`);

        if (name === null)
            continue;

        entries.push({name: name.trim(), path});
    }

    return entries;
}

/**
 * Temperature metric provider.
 *
 * Resolves its sensor once on construction. Hardware does not appear or vanish
 * mid-session for the drivers we care about, and re-scanning sysfs on every
 * tick would be wasteful.
 */
export class ThermalProvider {
    constructor() {
        this._sensor = selectSensor(discoverSensors());
    }

    /** @returns {string} stable identifier used in settings keys */
    get id() {
        return 'temperature';
    }

    /**
     * Short form for the panel, where width is scarce.
     *
     * @returns {string} abbreviated name
     */
    get label() {
        return 'TEMP';
    }

    /**
     * Full form for the preferences window, where there is room and clarity
     * matters more than width.
     *
     * @returns {string} human readable name
     */
    get name() {
        return 'Temperature';
    }

    /**
     * Logical icon name, resolved to a real icon by the UI layer. Bundled
     * because Adwaita has no temperature icon; its nearest options are weather
     * glyphs, which read as a forecast rather than a sensor.
     *
     * @returns {string} symbolic icon name
     */
    get iconName() {
        return 'system-monitor-temperature-symbolic';
    }

    /**
     * @returns {boolean} true if a recognised sensor was found and reads sanely
     */
    isAvailable() {
        if (this._sensor === null)
            return false;

        return this._readCelsius() !== null;
    }

    /**
     * Takes a reading.
     *
     * @returns {{celsius: number|null, sensor: string|null}} current temperature
     */
    sample() {
        return {
            celsius: this._readCelsius(),
            sensor: this._sensor?.name ?? null,
        };
    }

    /**
     * Formats a sample for the panel.
     *
     * @param {object|null} sample - reading from sample()
     * @param {object} [options] - formatting options
     * @param {string} [options.tempUnit] - "celsius" or "fahrenheit"
     * @returns {string} display text
     */
    format(sample, options = {}) {
        return formatTemperature(sample?.celsius ?? null, {
            unit: options.tempUnit ?? 'celsius',
        });
    }

    /**
     * Fill level for a ring, bar or dot.
     *
     * @param {object|null} sample - reading from sample()
     * @returns {number|null} 0 to 1 across the gauge range, or null
     */
    fraction(sample) {
        return temperatureFraction(sample?.celsius ?? null);
    }

    /**
     * Raw value for a self-scaling sparkline.
     *
     * @param {object|null} sample - reading from sample()
     * @returns {number|null} degrees Celsius, or null if not known
     */
    magnitude(sample) {
        return sample?.celsius ?? null;
    }

    /**
     * Stateless, present so every provider has the same shape.
     */
    reset() {
    }

    /**
     * @returns {number|null} current temperature in Celsius
     */
    _readCelsius() {
        if (this._sensor === null)
            return null;

        return millidegreesToCelsius(readInt(`${this._sensor.path}/temp1_input`));
    }
}
