/** @jest-environment node */

import {
  createPinnedRequestOptions,
  isPublicAddress,
  resolvePublicAddresses,
  safeFetchAdapter,
  setSafeFetchTransportForTests,
} from "@/lib/security/safe-fetch";

describe("safe outbound fetch DNS boundary", () => {
  afterEach(() => {
    setSafeFetchTransportForTests(undefined)
  })

  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.31.1.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    }
  );

  it("rejects a mixed DNS answer instead of selecting its public member", async () => {
    await expect(
      resolvePublicAddresses("attacker.example", async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ])
    ).rejects.toThrow(/private\/internal/);
  });

  it("connects to the approved IP while preserving origin routing and TLS identity", async () => {
    const approved = await resolvePublicAddresses(
      "attacker.example",
      async () => [{ address: "93.184.216.34", family: 4 }]
    );
    const options = createPinnedRequestOptions(
      new URL("https://attacker.example:8443/path?q=1"),
      approved
    );

    expect(options).toEqual(
      expect.objectContaining({
        hostname: "93.184.216.34",
        family: 4,
        port: 8443,
        path: "/path?q=1",
        servername: "attacker.example",
      })
    );
    expect(
      new Headers(options.headers as unknown as HeadersInit).get("host")
    ).toBe(
      "attacker.example:8443"
    );
  });

  it("forces library callers through manual redirect handling", async () => {
    const transport = jest.fn(async () =>
      new Response("ok", { status: 200 })
    )
    setSafeFetchTransportForTests(transport as typeof fetch)

    await safeFetchAdapter("https://example.com/mcp", {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "application/json" },
      body: '{"jsonrpc":"2.0"}',
    })

    expect(transport).toHaveBeenCalledWith(
      new URL("https://example.com/mcp"),
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
      })
    )
  })
});
