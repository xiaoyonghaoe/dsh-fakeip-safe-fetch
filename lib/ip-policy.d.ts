import type { LookupAddress } from 'node:dns';
import ipaddr from 'ipaddr.js';
export interface Address {
    readonly address: string;
    readonly family: 4 | 6;
}
export type Lookup = (hostname: string, options: {
    all: true;
    order: 'verbatim';
}) => Promise<LookupAddress[]>;
type Ip = ipaddr.IPv4 | ipaddr.IPv6;
export type Cidr = [Ip, number];
export declare const stripBrackets: (input: string) => string;
export declare function isPublicIp(input: string): boolean;
export declare function parseCidrs(values: readonly string[]): Cidr[];
export declare function isFakeIp(input: string, cidrs: readonly Cidr[]): boolean;
export declare function validateAddressShape(entries: readonly LookupAddress[]): Address[];
export declare function assertPublicAddresses(addresses: readonly Address[], lookup: Lookup, signal: AbortSignal): Promise<void>;
export {};
