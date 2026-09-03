'use strict';

// This module is bundled into cgi-bin/runtime.js at package build time.
// Neo JSH resolves a require() from the CGI process working directory rather
// than from the importing file, so a normal tree of relative CommonJS imports
// cannot be loaded directly by CGI. Bundling resolves those imports at build
// time while leaving JSH built-in modules as runtime requires.
module.exports = {
  bootstrap: require('./bootstrap.js'),
  http: require('./http.js'),
  jobApi: require('./job-api.js'),
  SettingsManager: require('../config/settings-manager.js').SettingsManager,
  InterfaceManager: require('../interfaces/manager.js').InterfaceManager,
  ProfileManager: require('../profiles/manager.js').ProfileManager,
  TestCallManager: require('../dbus/test-call.js').TestCallManager,
};
