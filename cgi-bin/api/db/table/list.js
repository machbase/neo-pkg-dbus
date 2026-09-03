'use strict';
const path = require('path');
const process = require('process');
const source = String(process.argv[1] || '');
const root = source.slice(0, source.lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
require(path.join(root, 'runtime.js')).bootstrap.runDb('table-list');
