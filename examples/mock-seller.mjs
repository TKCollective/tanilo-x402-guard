// A mock x402 seller for the examples and tests: answers 402 with a PAYMENT-REQUIRED header (encoded by the x402
// library's own encoder, passed in), and 200 to any request that carries a PAYMENT-SIGNATURE header. It does not
// check or settle the payment: nothing here touches a chain.
import http from "node:http";

export async function startMockSeller({ encodePaymentRequiredHeader, price, network, asset, payTo }) {
  const seen = { unpaid: 0, paid: 0 };
  const server = http.createServer((req, res) => {
    const url = `http://${req.headers.host}${req.url}`;
    if (req.headers["payment-signature"]) {
      seen.paid++;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ forecast: "sunny", paid: true }));
    }
    seen.unpaid++;
    const paymentRequired = {
      x402Version: 2,
      error: "payment required",
      resource: { url, description: "weather forecast" },
      accepts: [{ scheme: "exact", network, asset, amount: price(), payTo, maxTimeoutSeconds: 60, extra: {} }],
    };
    res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired), "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/weather`, seen, close: () => new Promise((r) => server.close(r)) };
}

// A payment scheme that produces a placeholder payload instead of signing a real transfer. Enough for the x402
// client to run its hooks and send a PAYMENT-SIGNATURE header to the mock seller.
export const mockScheme = {
  scheme: "exact",
  async createPaymentPayload(x402Version, requirements) {
    return { x402Version, payload: { mock: true, amount: requirements.amount } };
  },
};
