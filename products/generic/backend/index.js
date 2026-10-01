'use strict';

function validateProductConfig(config) {
  // Synthetic input belongs exclusively to the LS internal benchmark path.
  // Generic accepts old/new schema documents but always fails the flag closed.
  if (config && config.execution) config.execution.test = false;
  return config;
}

module.exports = { target: 'generic', minimumIntervalMs: 1000, validateProductConfig };
