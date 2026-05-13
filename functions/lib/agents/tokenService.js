"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateToken = generateToken;
exports.verifyToken = verifyToken;
const crypto = __importStar(require("crypto"));
function b64url(buf) {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function b64urlDecode(s) {
    return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function getSecret() {
    const s = process.env.JWT_SECRET;
    if (!s)
        throw new Error("JWT_SECRET env var not set");
    return s;
}
function generateToken(payload, ttlSeconds = 7200) {
    const full = Object.assign(Object.assign({}, payload), { exp: Math.floor(Date.now() / 1000) + ttlSeconds });
    const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
    const body = b64url(Buffer.from(JSON.stringify(full)));
    const sig = b64url(crypto.createHmac("sha256", getSecret()).update(`${header}.${body}`).digest());
    return `${header}.${body}.${sig}`;
}
function verifyToken(token) {
    try {
        const parts = token.split(".");
        if (parts.length !== 3)
            return null;
        const [header, body, sig] = parts;
        const expected = b64url(crypto.createHmac("sha256", getSecret()).update(`${header}.${body}`).digest());
        if (sig !== expected)
            return null;
        const payload = JSON.parse(b64urlDecode(body).toString());
        if (payload.exp < Math.floor(Date.now() / 1000))
            return null;
        return payload;
    }
    catch (_a) {
        return null;
    }
}
//# sourceMappingURL=tokenService.js.map