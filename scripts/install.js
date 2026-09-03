'use strict';

const path = require('path');
const process = require('process');
require(path.join(path.resolve(path.dirname(process.argv[1] || '.')), 'lifecycle.js')).install();
