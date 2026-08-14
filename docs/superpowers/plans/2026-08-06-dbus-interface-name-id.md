# DBus Interface 이름과 내부 ID 분리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자는 관리용 `name`만 입력하고, 서버는 충돌 없는 내부 `id`를 생성한다.

**Architecture:** Interface document에는 `id`와 `name`을 함께 저장한다. POST는 `id`를 받지 않고 manager가 생성 잠금 안에서 `name` slug 또는 Interface slug 기반의 사용 가능한 ID를 선택한다. PUT·GET·DELETE와 Job의 `interfaceId`는 기존 내부 ID를 계속 쓴다.

**Tech Stack:** Node.js CGI, React, JSON 파일 저장소, node:test.

### Task 1: API·저장 모델

- [x] 실패 테스트: POST에서 `name`으로 ID를 자동 생성하고 같은 이름은 다른 ID가 되는지 검사한다.
- [x] 구현: validator·manager·store·CGI에 `name`과 서버 ID 할당을 넣는다.
- [x] 검증: Interface API 테스트와 전체 backend 테스트를 실행한다.

### Task 2: 화면·계약

- [x] 실패 테스트: Add 모달이 Name만 입력하고 POST body에 id를 보내지 않는지 검사한다.
- [x] 구현: ID 입력을 Name 입력으로 바꾸고 목록·상세에 name을 표시한다.
- [x] 검증: frontend build/test, 계약 문서 갱신, 전체 회귀를 실행한다.
