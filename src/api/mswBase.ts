// 浏览器内用相对路径匹配同源请求；Node（vitest / msw/node）下需要绝对地址
export const apiBase = typeof window === 'undefined' ? 'http://localhost' : ''
