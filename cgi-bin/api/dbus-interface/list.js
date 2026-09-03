'use strict';
const path = require('path'); const process = require('process'); const marker = `${path.sep}cgi-bin${path.sep}`; const root = process.argv[1].slice(0, process.argv[1].indexOf(marker) + marker.length - 1);
const { http, InterfaceManager } = require(path.join(root, 'runtime.js'));
if (String((process.env.get && process.env.get('REQUEST_METHOD')) || process.env.REQUEST_METHOD || 'GET') !== 'GET') http.fail(Object.assign(new Error('지원하지 않는 요청 method입니다.'), { code: 'METHOD_NOT_ALLOWED' }), 405);
else { const factory = http.createFactory(() => new InterfaceManager({ cgiRoot: root })); if (!factory.ok) http.fail(factory.error); else { try { http.reply(200, { ok: true, data: factory.value.listInterfaces() }); } catch (failure) { http.fail(failure); } } }
