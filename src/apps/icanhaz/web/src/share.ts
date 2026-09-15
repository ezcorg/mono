// Share bundles: how a document travels with the authority its blocks need.
//
// A bundle is `{document, issuer, grants: [certificate…]}` as a prefixed
// base64url JSON string, so it fits a link, a message or a note's front
// matter. Each grant is an `ezcap1.…` certificate the issuing broker signed:
// a sturdy reference to a grant the owner holds, bound to an audience (the
// recipient's origin or peer key), narrowed at share time. It carries no
// bearer secret; the recipient redeems it at the issuing broker for a grant
// of their own, narrowed by every clause in the chain (see broker.wit).
//
// Today a bundle redeems at the broker this client is connected to (the
// recipient shares the owner's daemon, e.g. another origin or a peer of it);
// redemption at a remote broker over iroh, with the local daemon proxying
// the grant, is the M5 remote-provider work.

import type { Transport } from "./wrpc";
import { certify, identity, redeem, type Audience, type Scope } from "./generated/broker";

const PREFIX = "ezbundle1.";

export interface Share {
    /** A grant this client holds. */
    token: string;
    /** Who may redeem the certificate. */
    audience: Audience;
    /** How long the certificate is good for (capped at the grant's remaining life). */
    ttlSecs: number;
    /** Clauses to append at share time; `"true"` fields add nothing. */
    extra?: Scope;
    /** What the recipient sees this grant as, for their consent-free listing. */
    summary?: string;
}

export interface Bundle {
    v: 1;
    /** The document this authority belongs with (a vault-relative path or id). */
    document?: string;
    /** The issuing broker's public key (base64url Ed25519); its iroh endpoint id. */
    issuer: string;
    grants: { cert: string; summary?: string }[];
}

function b64url(s: string): string {
    return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): string {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    return decodeURIComponent(escape(atob(padded)));
}

export function encodeBundle(bundle: Bundle): string {
    return PREFIX + b64url(JSON.stringify(bundle));
}

export function decodeBundle(text: string): Bundle {
    const body = text.trim();
    if (!body.startsWith(PREFIX)) throw new Error("not a share bundle: missing `ezbundle1.` prefix");
    const bundle = JSON.parse(unb64url(body.slice(PREFIX.length))) as Bundle;
    if (bundle.v !== 1 || typeof bundle.issuer !== "string" || !Array.isArray(bundle.grants)) {
        throw new Error("not a share bundle: malformed");
    }
    return bundle;
}

/** The public root of a certificate: readable by anyone, without any key. */
export interface CertificateRoot {
    instance: string;
    issuer: string;
    audience: { any: null } | { origin: string } | { peer: string } | "any";
    /** Unix seconds; 0 = never. */
    expires: number;
}

export function certificateRoot(cert: string): CertificateRoot {
    if (!cert.startsWith("ezcap1.")) throw new Error("not a certificate");
    const parsed = JSON.parse(unb64url(cert.slice("ezcap1.".length))) as { root: CertificateRoot };
    return parsed.root;
}

/**
 * Certify each share at the connected broker and package the certificates
 * with the document reference. Every certificate is signed by the broker,
 * bound to its audience, and narrowed by `extra`; the caller's tokens never
 * leave this client.
 */
export async function createBundle(t: Transport, document: string | undefined, shares: Share[]): Promise<string> {
    const issuer = await identity(t);
    const grants: Bundle["grants"] = [];
    for (const s of shares) {
        const res = await certify(t, s.token, s.audience, BigInt(s.ttlSecs), s.extra ?? { when: "true", allow: "true" });
        if (res.tag !== "ok") throw new Error(`could not certify a grant: ${JSON.stringify(res.val)}`);
        grants.push({ cert: res.val, summary: s.summary });
    }
    return encodeBundle({ v: 1, document, issuer, grants });
}

export interface OpenedBundle {
    document?: string;
    /** One entry per certificate: the redeemed grant token, or why it was refused. */
    grants: ({ summary?: string; token: string } | { summary?: string; refused: string })[];
}

/**
 * Redeem every certificate in `text` at the connected broker. Refuses
 * outright when the bundle was issued by another broker: this client cannot
 * reach it (M5). Individual certificates may still be refused (wrong
 * audience, expired, source revoked); each entry says so.
 */
export async function openBundle(t: Transport, text: string): Promise<OpenedBundle> {
    const bundle = decodeBundle(text);
    const here = await identity(t);
    if (bundle.issuer !== here) {
        throw new Error(`bundle was issued by another broker (${bundle.issuer.slice(0, 8)}…); this client is connected to ${here.slice(0, 8)}…`);
    }
    const grants: OpenedBundle["grants"] = [];
    for (const g of bundle.grants) {
        const res = await redeem(t, g.cert);
        if (res.tag === "ok") grants.push({ summary: g.summary, token: res.val.token });
        else grants.push({ summary: g.summary, refused: res.val.tag });
    }
    return { document: bundle.document, grants };
}
