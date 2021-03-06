/**
 * Is.js
 *
 * Object type checks.
 */

const NAME = Symbol.toStringTag

/**
 * Check if `obj` is a URLSearchParams object
 * ref: https://github.com/node-fetch/node-fetch/issues/296#issuecomment-307598143
 *
 * @param  {*} obj
 * @return {boolean}
 */
export function isURLSearchParams (object) {
  return (
    typeof object === 'object' &&
    typeof object.append === 'function' &&
    typeof object.delete === 'function' &&
    typeof object.get === 'function' &&
    typeof object.getAll === 'function' &&
    typeof object.has === 'function' &&
    typeof object.set === 'function' &&
    typeof object.sort === 'function' &&
    object[NAME] === 'URLSearchParams'
  )
}

/**
 * Check if `obj` is a W3C `Blob` object (which `File` inherits from)
 *
 * @param  {*} obj
 * @return {boolean}
 */
export function isBlob (object) {
  return (
    typeof object === 'object' &&
    typeof object.arrayBuffer === 'function' &&
    typeof object.type === 'string' &&
    typeof object.stream === 'function' &&
    typeof object.constructor === 'function' &&
    /^(Blob|File)$/.test(object[NAME])
  )
}

/**
 * Check if `obj` is an instance of AbortSignal.
 *
 * @param  {*} obj
 * @return {boolean}
 */
export function isAbortSignal (object) {
  return (
    typeof object === 'object' &&
    object[NAME] === 'AbortSignal'
  )
}

/**
 * Check if `obj` is an instance of ArrayBuffer.
 *
 * @param  {*} obj
 * @return {boolean}
 */
export function isArrayBuffer (object) {
  return object[NAME] === 'ArrayBuffer'
}

/**
 * Check if `obj` is an instance of AbortError.
 *
 * @param  {*} obj
 * @return {boolean}
 */
export function isAbortError (object) {
  return object[NAME] === 'AbortError'
}
