'use strict';

const fs = require('fs');
const path = require('path');

const genericPolicy = {
  target: 'generic',
  validateProductConfig(config) { return config; },
};

function loadProductPolicy(cgiRoot) {
  const file = path.join(cgiRoot, 'product', 'index.js');
  if (!fs.existsSync(file)) return genericPolicy;
  const policy = require(file);
  if (!policy || !['generic', 'ls'].includes(policy.target)
    || typeof policy.validateProductConfig !== 'function') {
    throw new Error('Product Backend module is invalid.');
  }
  return policy;
}

module.exports = { loadProductPolicy };
