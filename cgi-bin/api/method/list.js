'use strict';

const path = require('path');
const process = require('process');
const marker = `${path.sep}cgi-bin${path.sep}`;
const root = process.argv[1].slice(0, process.argv[1].indexOf(marker) + marker.length - 1);
const http = require(path.join(root, 'src', 'cgi', 'http.js'));
const { ProfileManager } = require(path.join(root, 'src', 'profiles', 'manager.js'));

const managerFactory = http.createFactory(() => new ProfileManager({ cgiRoot: root }));

if (!managerFactory.ok) {
  http.fail(managerFactory.error);
} else if (String((process.env.get && process.env.get('REQUEST_METHOD')) || process.env.REQUEST_METHOD || '') !== 'GET') {
  http.fail(Object.assign(new Error('GET 요청만 사용할 수 있습니다.'), { code: 'METHOD_NOT_ALLOWED' }), 405);
} else {
  const query = http.readQuery();
  if (!query.ok) http.fail(query.error, 400);
  else {
    let parameters;
    try {
      parameters = http.requireStringFields(query.value, ['profileId']);
    } catch (requestError) {
      http.fail(requestError);
    }
    if (parameters) managerFactory.value.listMethods(parameters.profileId, (error, value) => {
      if (error) http.fail(error);
      else http.reply(200, { ok: true, data: value });
    });
  }
}
