# Выпуск новой версии

Релиз собирается GitHub Actions на чистом Windows runner и публикуется при отправке тега `v*`.

## Перед тегом

1. Обновить `version` в `package.json` и `package-lock.json`.
2. Обновить `CHANGELOG.md` и проверить оба README.
3. Выполнить:

   ```powershell
   npm ci
   npm run typecheck
   npm run check
   npm run app:build
   ```

4. Запустить smoke-проверку из `.ai/verification.md`.
5. Проверить установщик и portable-версию на чистой Windows VM.

## Публикация

```powershell
git tag -a v1.0.1 -m "popingui 1.0.1"
git push origin main
git push origin v1.0.1
```

Workflow приложит к GitHub Release NSIS-установщик, portable EXE и `SHA256SUMS.txt`.
Сборки пока не подписаны кодовым сертификатом, поэтому SmartScreen может показать предупреждение.
