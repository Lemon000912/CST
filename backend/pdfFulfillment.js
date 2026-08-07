import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 4;
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

export class PdfFulfillmentError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "PdfFulfillmentError";
    this.code = code;
    this.status = status;
  }
}

function isBlockedIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isBlockedIp(address) {
  const normalized = String(address || "").toLowerCase().split("%")[0];
  const family = net.isIP(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family !== 6) return true;
  if (normalized === "::" || normalized === "::1") return true;
  if (/^fe[89ab]/.test(normalized)) return true; // link-local
  if (/^f[cd]/.test(normalized)) return true; // unique-local
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  // Documentation, multicast, and other non-global ranges.
  return normalized.startsWith("2001:db8:") || normalized.startsWith("ff");
}

async function validateAndResolve(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PdfFulfillmentError("invalid-pdf-source", "Stored PDF source URL is invalid", 422);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PdfFulfillmentError("invalid-pdf-source", "Stored PDF source must use HTTP or HTTPS", 422);
  }
  if (url.username || url.password) {
    throw new PdfFulfillmentError("invalid-pdf-source", "Stored PDF source must not contain credentials", 422);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new PdfFulfillmentError("blocked-pdf-source", "Stored PDF source host is not allowed", 422);
  }

  let addresses;
  if (net.isIP(hostname)) {
    addresses = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new PdfFulfillmentError("pdf-source-unreachable", "PDF source host could not be resolved");
    }
  }
  if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
    throw new PdfFulfillmentError("blocked-pdf-source", "PDF source resolved to a non-public address", 422);
  }
  return { url, address: addresses[0] };
}

function requestOnce(url, pinnedAddress, { maxBytes, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.get(url, {
      headers: {
        Accept: "application/pdf,application/octet-stream;q=0.8",
        "User-Agent": "QuantumPinnacle-PdfFulfillment/1.0",
      },
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) return callback(null, [pinnedAddress]);
        return callback(null, pinnedAddress.address, pinnedAddress.family);
      },
    });
    const timer = setTimeout(() => {
      request.destroy(new PdfFulfillmentError("pdf-fetch-timeout", "PDF source timed out", 504));
    }, timeoutMs);

    request.on("response", (response) => {
      const status = Number(response.statusCode || 0);
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        clearTimeout(timer);
        return resolve({ redirect: new URL(location, url).toString() });
      }
      if (status < 200 || status >= 300) {
        response.resume();
        clearTimeout(timer);
        return reject(new PdfFulfillmentError("pdf-source-error", `PDF source returned HTTP ${status}`, 502));
      }

      const declaredLength = Number(response.headers["content-length"] || 0);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy();
        clearTimeout(timer);
        return reject(new PdfFulfillmentError("pdf-too-large", "PDF exceeds the server size limit", 413));
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy(new PdfFulfillmentError("pdf-too-large", "PDF exceeds the server size limit", 413));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        clearTimeout(timer);
        resolve({
          buffer: Buffer.concat(chunks, total),
          contentType: String(response.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase(),
          finalUrl: url.toString(),
        });
      });
      response.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof PdfFulfillmentError
        ? error
        : new PdfFulfillmentError("pdf-source-unreachable", "PDF source could not be fetched"));
    });
  });
}

export async function fetchPdfSecurely(rawUrl, options = {}) {
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_BYTES;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const maxRedirects = Number.isSafeInteger(options.maxRedirects) && options.maxRedirects >= 0
    ? options.maxRedirects
    : DEFAULT_MAX_REDIRECTS;

  let nextUrl = String(rawUrl || "").trim();
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const { url, address } = await validateAndResolve(nextUrl);
    const result = await requestOnce(url, address, { maxBytes, timeoutMs });
    if (result.redirect) {
      if (redirectCount === maxRedirects) {
        throw new PdfFulfillmentError("too-many-redirects", "PDF source redirected too many times", 502);
      }
      nextUrl = result.redirect;
      continue;
    }
    if (result.buffer.length < 5 || result.buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new PdfFulfillmentError("invalid-pdf-content", "Fetched content is not a PDF", 422);
    }
    if (result.contentType && !["application/pdf", "application/octet-stream", "binary/octet-stream"].includes(result.contentType)) {
      throw new PdfFulfillmentError("invalid-pdf-content-type", "PDF source returned an unexpected content type", 422);
    }
    return result;
  }
  throw new PdfFulfillmentError("too-many-redirects", "PDF source redirected too many times", 502);
}
