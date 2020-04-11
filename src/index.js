/**
 * index.js
 *
 * a request API compatible with window.fetch
 */

// eslint-disable-next-line node/no-deprecated-api
import { resolve as resolveURL } from 'url'
import Stream, { PassThrough, pipeline as pump } from 'stream'

import { writeToStream } from './body'
import Response from './response'
import Headers from './headers'
import Request, { getNodeRequestOptions } from './request'
import FetchError from './errors/fetch-error'
import AbortError from './errors/abort-error'

const electron = require('electron')

const isReady = (!electron || electron.app.isReady())
  ? Promise.resolve()
  : new Promise(resolve => electron.app.once('ready', resolve))

/**
 * Fetch function
 *
 * @param {string|Request} url Absolute url or Request instance
 * @param {Object} [opts] Fetch options
 * @return {Promise}
 */
export default function fetch (url, opts = {}) {
  // wrap http.request into fetch
  return isReady.then(() => new Promise((resolve, reject) => {
    // build request object
    const request = new Request(url, opts)

    const options = getNodeRequestOptions(request)

    const send = electron.net.request // http.request only support string as host header, this hack make custom host header possible
    if (options.headers.host) {
      options.headers.host = options.headers.host[0]
    }

    // send request
    let headers

    headers = options.headers
    delete options.headers
    options.session = opts.session || electron.session.defaultSession // we have to use a persistent session here, because of https://github.com/electron/electron/issues/13587

    const { signal } = request
    let response = null

    const abort = () => {
      const error = new AbortError('The operation was aborted.')
      reject(error)
      if (request.body && request.body instanceof Stream.Readable) {
        request.body.destroy(error)
      }

      if (!response || !response.body) {
        return
      }

      response.body.emit('error', error)
    }

    if (signal && signal.aborted) {
      abort()
      return
    }

    const abortAndFinalize = () => {
      abort()
      finalize()
    }

    if (signal) {
      signal.addEventListener('abort', abortAndFinalize)
    }

    function finalize () {
      req.abort()
      if (signal) {
        signal.removeEventListener('abort', abortAndFinalize)
      }
    }

    if (request.timeout) {
      req.setTimeout(request.timeout, () => {
        finalize()
        reject(new FetchError(`network timeout at: ${request.url}`, 'request-timeout'))
      })
    }

    // Send request
    const req = send(options)
    for (const headerName in headers) {
      if (typeof headers[headerName] === 'string') req.setHeader(headerName, headers[headerName])
      else {
        for (const headerValue of headers[headerName]) {
          req.setHeader(headerName, headerValue)
        }
      }
    }

    let reqTimeout

    if (request.timeout) {
      reqTimeout = setTimeout(() => {
        req.abort()
        reject(new FetchError(`network timeout at: ${request.url}`, 'request-timeout'))
      }, request.timeout)
    }

    // handle authenticating proxies
    req.on('login', (authInfo, callback) => {
      if (opts.user && opts.password) {
        callback(opts.user, opts.password)
      } else {
        req.abort()
        reject(new FetchError(`login event received from ${authInfo.host} but no credentials provided`, 'proxy', { code: 'PROXY_AUTH_FAILED' }))
      }
    })

    req.on('error', err => {
      clearTimeout(reqTimeout)
      reject(new FetchError(`request to ${request.url} failed, reason: ${err.message}`, 'system', err))
    })

    req.on('response', res => {
      clearTimeout(reqTimeout)

      // handle redirect
      if (fetch.isRedirect(res.statusCode) && request.redirect !== 'manual') {
        if (request.redirect === 'error') {
          reject(new FetchError(`redirect mode is set to error: ${request.url}`, 'no-redirect'))
          return
        }

        if (request.counter >= request.follow) {
          reject(new FetchError(`maximum redirect reached at: ${request.url}`, 'max-redirect'))
          return
        }

        if (!res.headers.location) {
          reject(new FetchError(`redirect location header missing at: ${request.url}`, 'invalid-redirect'))
          return
        }

        // per fetch spec, for POST request with 301/302 response, or any request with 303 response, use GET when following redirect
        if (res.statusCode === 303 ||
          ((res.statusCode === 301 || res.statusCode === 302) && request.method === 'POST')) {
          request.method = 'GET'
          request.body = null
          request.headers.delete('content-length')
        }

        request.counter++

        resolve(fetch(resolveURL(request.url, res.headers.location), request))
        return
      }

      // normalize location header for manual redirect mode
      const headers = new Headers()
      for (const name of Object.keys(res.headers)) {
        if (Array.isArray(res.headers[name])) {
          for (const val of res.headers[name]) {
            headers.append(name, val)
          }
        } else {
          headers.append(name, res.headers[name])
        }
      }
      if (request.redirect === 'manual' && headers.has('location')) {
        headers.set('location', resolveURL(request.url, headers.get('location')))
      }

      // Prepare response
      res.once('end', () => {
        if (signal) {
          signal.removeEventListener('abort', abortAndFinalize)
        }
      })
      const body = pump(res, new PassThrough(), error => {
        reject(error)
      })

      const responseOptions = {
        url: request.url,
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: headers,
        size: request.size,
        timeout: request.timeout,
        useElectronNet: request.useElectronNet
      }

      response = new Response(body, responseOptions)
      resolve(response)
    })

    writeToStream(req, request)
  }))
}

/**
 * Redirect code matching
 *
 * @param {number} code Status code
 * @return {boolean}
 */
fetch.isRedirect = code => [301, 302, 303, 307, 308].includes(code)

export {
  Headers,
  Request,
  Response,
  FetchError
}
