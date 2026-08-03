#!/usr/bin/env -S gjs -m
/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Test entry point.
 *
 * Runs under plain gjs with no display server:
 *
 *     gjs -m tests/run.js
 *
 * Importing a test module runs its tests, so adding a suite means adding one
 * import here.
 */

import System from 'system';

import './procfs.test.js';
import './units.test.js';
import './cpu.test.js';
import './memory.test.js';
import './icons.test.js';
import './rates.test.js';
import './network.test.js';
import './disk.test.js';
import './thermal.test.js';
import './presets.test.js';
import './history.test.js';
import './stylesheet.test.js';
import './draw.test.js';
import './poller.test.js';

import {report} from './harness.js';

System.exit(report());
