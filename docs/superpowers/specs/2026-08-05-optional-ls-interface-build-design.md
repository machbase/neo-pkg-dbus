# 선택형 LS Interface 빌드 설계

## 목적

LS PLC 기본 DBus Interface를 패키지 빌드에 넣을지 빼는지를 빌드 명령으로 고른다. 기본 빌드는 빈 DBus Interface 목록으로 시작하고, LS Interface 포함 빌드만 읽기 전용 기본 항목을 제공한다.

## 빌드 명령

프런트엔드 폴더에서 다음 명령을 사용한다.

```bash
cd frontend
npm run build:root
npm run build:root -- --with-ls-interface
```

`build:root`는 기본 빌드이며 LS Interface를 포함하지 않는다. `--with-ls-interface`는 LS Interface를 포함한다. 알 수 없는 빌드 옵션은 실패한다.

## 파일 처리

Git으로 관리하는 원본은 다음 경로에 둔다.

```text
build-assets/interfaces/ls-plc-device.json
```

LS 포함 빌드만 원본을 다음 패키지 경로로 복사한다.

```text
cgi-bin/interfaces.d/ls-plc-device.json
```

빌드는 `cgi-bin/interfaces.d`의 빌드 산출물만 다시 만든다. 따라서 LS 포함 빌드 뒤에 기본 빌드를 해도 기본 파일이 남지 않는다. `cgi-bin/conf.d/interfaces`와 `cgi-bin/conf.d/jobs`는 사용자 데이터이므로 빌드가 읽거나 바꾸지 않는다.

## 실행 계약

- `interfaces.d`가 없거나 비어 있어도 Backend와 화면은 정상 시작한다.
- LS 포함 빌드는 `system → ls.plc → /ls/plc/device → ls.plc.device → GetDeviceData`를 `builtIn: true`로 제공하며 수정·삭제를 막는다.
- 기본 빌드는 빈 목록으로 시작한다. 사용자는 Discover 또는 직접 입력으로 Interface와 Method를 추가한다.
- `GET /dbus-interface/list`와 Job 생성 화면은 기본 Interface가 있다는 가정을 하지 않는다.
- LS Interface가 없는 빌드에서 이를 참조한 Job은 `DBUS_INTERFACE_NOT_FOUND`로 검증·시작을 거부한다.

## 검증

- 기본 빌드 뒤 `cgi-bin/interfaces.d/ls-plc-device.json`이 없다.
- LS 포함 빌드 뒤 파일이 있고 `builtIn: true`로 읽힌다.
- 두 빌드 모두 빈 사용자 설정에서 Interface 목록과 Job 생성 화면이 정상 동작한다.
- 빌드가 `conf.d/interfaces`, `conf.d/jobs`를 바꾸지 않는다.
- 지원하지 않는 옵션은 빌드 실패를 반환한다.
