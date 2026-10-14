// 以 contracts/ 的 JSON Schema 驗證請求／資料。模組透過 ctx.validate(ref, data) 使用。
import { createValidator } from '../../contracts/index.js';
import { validation } from './errors.js';

let shared;

/** 取得共用的驗證器（只編譯一次） */
export function getValidator() {
  shared ??= createValidator();
  return shared;
}

/**
 * 回傳 validate(ref, data) 函式：通過回傳 data，失敗丟 400 VALIDATION（details 為 ajv 錯誤陣列）。
 * ref 寫法見 contracts/index.js，例：'api-inventory#DeviceCreate'。
 */
export function createValidatorFn(validator = getValidator()) {
  return function validate(ref, data) {
    const r = validator.validate(ref, data);
    if (!r.valid) {
      const first = r.errors[0];
      const where = first?.instancePath ? `（${first.instancePath}）` : '';
      throw validation(`請求內容不正確${where}：${first?.message ?? ''}`.trim(), r.errors);
    }
    return data;
  };
}
