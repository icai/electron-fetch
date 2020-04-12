/**
 * Fetch-error.js
 *
 * FetchError interface for operational errors
 */

/**
 * Create FetchError instance
 *
 * @param   String      message      Error message for human
 * @param   String      type         Error type for machine
 * @param   Object      systemError  For Node.js system error
 * @return  FetchError
 */

const netErrorMap = {
  ERR_CONNECTION_REFUSED: 'ECONNREFUSED',
  ERR_EMPTY_RESPONSE: 'ECONNRESET',
  ERR_NAME_NOT_RESOLVED: 'ENOTFOUND',
  ERR_CONTENT_DECODING_FAILED: 'Z_DATA_ERROR',
  ERR_CONTENT_DECODING_INIT_FAILED: 'Z_DATA_ERROR'
}
export default class FetchError extends Error {
	constructor(message, type, systemError) {
		super(message);

    const regex = /^.*net::(.*)/
    if (regex.test(message)) {
      let errorCode = regex.exec(message)[1]
      // istanbul ignore else
      if (Object.prototype.hasOwnProperty.call(netErrorMap, errorCode)) errorCode = netErrorMap[errorCode]
      systemError = { code: errorCode }
    }
    this.message = message
    this.type = type
		this.name = 'FetchError'
		this[Symbol.toStringTag] = 'FetchError'

  
		// When err.type is `system`, err.erroredSysCall contains system error and err.code contains system error code
		if (systemError) {
			// eslint-disable-next-line no-multi-assign
			this.code = this.errno = systemError.code;
			this.erroredSysCall = systemError;
		}
  
    // hide custom error implementation details from end-users
    Error.captureStackTrace(this, this.constructor)
	}
}

