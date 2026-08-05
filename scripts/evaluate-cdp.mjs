const [endpoint, expression] = process.argv.slice(2);
const endpointUrl = new URL(endpoint || "about:blank");

if (endpointUrl.protocol !== "ws:" || endpointUrl.hostname !== "127.0.0.1" || !expression) {
  throw new Error("CDP evaluator requires a ws://127.0.0.1 endpoint and expression");
}

const socket = new WebSocket(endpointUrl);

function withTimeout(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP operation timed out")), 30_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

try {
  await withTimeout(
    new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true });
    })
  );

  const response = withTimeout(
    new Promise((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        if (message.error || message.result?.exceptionDetails) {
          const details = message.result?.exceptionDetails;
          const description = details?.exception?.description || details?.text || message.error?.message || "unknown error";
          reject(new Error(`CDP evaluation failed: ${description}`));
          return;
        }
        resolve(message.result?.result?.value ?? null);
      });
    })
  );

  socket.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true }
    })
  );
  process.stdout.write(JSON.stringify(await response));
} finally {
  if (socket.readyState < WebSocket.CLOSING) socket.close();
}
