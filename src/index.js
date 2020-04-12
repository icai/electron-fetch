/**
 * index.js
 *
 * a request API compatible with window.fetch
 */

// eslint-disable-next-line node/no-deprecated-api
import { resolve as resolveURL } from 'url'
import * as zlib from 'zlib'
import Stream, { PassThrough, pipeline as pump } from 'stream'
import dataURIToBuffer from 'data-uri-to-buffer'

import Body, { writeToStream, getTotalBytes } from './body'
import Response from './response'
import Headers, { createHeadersLenient } from './headers'
import Request, { getNodeRequestOptions } from './request'
import FetchError from './errors/fetch-error'
import AbortError from './errors/abort-error'

import debug from 'debug'

const log = debug('server')

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
  // Regex for data uri
  const dataUriRegex = /^\s*data:([a-z]+\/[a-z]+(;[a-z-]+=[a-z-]+)?)?(;base64)?,[\w!$&',()*+;=\-.~:@/?%\s]*\s*$/i

  // If valid data uri
  if (dataUriRegex.test(url)) {
    const data = dataURIToBuffer(url)
    const res = new Response(data, { headers: { 'Content-Type': data.type } })
    return Promise.resolve(res)
  }

  // If invalid data uri
  if (url.toString().startsWith('data:')) {
    const request = new Request(url, opts)
    return Promise.reject(new FetchError(`[${request.method}] ${request.url} invalid URL`, 'system'))
  }

  // wrap http.request into fetch
  return isReady.then(() => new Promise((resolve, reject) => {
    // build request object
    const request = new Request(url, opts)

    const options = getNodeRequestOptions(request)

    const send = electron.net.request // http.request only support string as host header, this hack make custom host header possible
    if (Array.isArray(options.headers.host)) {
      options.headers.host = options.headers.host[0]
    }

    // send request
    let headers

    headers = options.headers
    delete options.headers
    options.session = opts.session || electron.session.defaultSession // we have to use a persistent session here, because of https://github.com/electron/electron/issues/13587

    delete options.signal

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

    let redirect_status = request.status
    let redirect_method = request.method
    const redirect_url = request.url
    let redirect_headers = request.headers
    req.on('redirect', (statusCode, method, redirectUrl, responseHeaders) => {
      const headers = createHeadersLenient(responseHeaders)

      redirect_status = statusCode
      redirect_method = method
      redirect_headers = headers
    })

    req.on('response', res => {
      clearTimeout(reqTimeout)

      let headers = createHeadersLenient(res.headers)

      // HTTP fetch step 5.2
      const location = redirect_headers.get('Location')

      // Prepare response
      res.once('end', () => {
        if (signal) {
          signal.removeEventListener('abort', abortAndFinalize)
        }
      })

      // HTTP fetch step 5
      if (fetch.isRedirect(redirect_status)) {
        // HTTP fetch step 5.3
        const locationURL = location === null ? null : resolveURL(request.url, location)

        // HTTP fetch step 5.5
        switch (request.redirect) {
          case 'error':
            reject(new FetchError(`uri requested responds with a redirect, redirect mode is set to error: ${request.url}`, 'no-redirect'))
            finalize()
            return
          case 'manual':
            // Node-fetch-specific step: make manual redirect a bit easier to use by setting the Location header value to the resolved URL.
            if (locationURL !== null) {
              // Handle corrupted header
              try {
                if (location) {
                  redirect_headers.set('Location', locationURL)
                  headers = redirect_headers
                }
              } catch (error) {
                // istanbul ignore next: nodejs server prevent invalid response headers, we can't test this through normal request
                reject(error)
              }
            }

            break
          case 'follow': {
            // HTTP-redirect fetch step 2
            if (locationURL === null) {
              break
            }

            // HTTP-redirect fetch step 5
            if (request.counter >= request.follow) {
              reject(new FetchError(`maximum redirect reached at: ${request.url}`, 'max-redirect'))
              finalize()
              return
            }
            if (!location) {
              reject(new FetchError(`redirect location header missing at: ${request.url}`, 'invalid-redirect'))
              finalize()
              return
            }

            // HTTP-redirect fetch step 6 (counter increment)
            // Create a new Request object.
            const requestOptions = {
              headers: new Headers(request.headers),
              follow: request.follow,
              counter: request.counter + 1,
              agent: request.agent,
              compress: request.compress,
              method: redirect_method || request.method,
              body: request.body,
              signal: request.signal,
              timeout: request.timeout
            }

            // HTTP-redirect fetch step 9
            if (redirect_status !== 303 && request.body && getTotalBytes(request) === null) {
              reject(new FetchError('Cannot follow redirect with body being a readable stream', 'unsupported-redirect'))
              finalize()
              return
            }

            // HTTP-redirect fetch step 11
            if (redirect_status === 303 || ((redirect_status === 301 || redirect_status === 302) && redirect_method === 'POST')) {
              requestOptions.method = 'GET'
              requestOptions.body = undefined
              requestOptions.headers.delete('content-length')
            }

            // HTTP-redirect fetch step 15
            resolve(fetch(new Request(locationURL, requestOptions)))
            finalize()
            return
          }

          default:
          // Do nothing
        }
      }

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
        counter: request.counter,
        highWaterMark: request.highWaterMark
      }

      if (request.redirect == 'manual' && location) {
        responseOptions.status = redirect_status
      }

      // HTTP-network fetch step 12.1.1.3
      const codings = headers.get('Content-Encoding')

      // HTTP-network fetch step 12.1.1.4: handle content codings

      // in following scenarios we ignore compression support
      // 1. compression support is disabled
      // 2. HEAD request
      // 3. no Content-Encoding header
      // 4. no content response (204)
      // 5. content not modified response (304)
      if (!request.compress || request.method === 'HEAD' || codings === null || res.statusCode === 204 || res.statusCode === 304) {
        response = new Response(body, responseOptions)
        resolve(response)
        return
      }

      // Otherwise, use response as-is
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
  FetchError,
  AbortError
}
