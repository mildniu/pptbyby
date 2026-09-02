export function log(tag: string, message: string, data?: any) {
  const time = new Date().toLocaleString('zh-CN', { hour12: false });
  const dataStr = data !== undefined ? (typeof data === 'string' ? data : JSON.stringify(data)) : '';
  console.log(`[${time}] [${tag}] ${message} ${dataStr}`.trim());
}

export function logError(tag: string, message: string, error?: any) {
  const time = new Date().toLocaleString('zh-CN', { hour12: false });
  const errStr = error ? (error.stack || error.message || String(error)) : '';
  console.error(`[${time}] [${tag}] ❌ ${message} ${errStr}`.trim());
}
