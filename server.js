const path = require("path");
const { createServer } = require("http");
const { parse } = require("url");
const fs = require("fs");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const dir = path.join(__dirname);
const nextDir = path.join(dir, ".next");

process.env.NODE_ENV = "production";
process.chdir(dir);

const currentPort = parseInt(process.env.PORT, 10) || 3000;
const hostname = process.env.HOSTNAME || "0.0.0.0";

let keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT, 10);
if (
  Number.isNaN(keepAliveTimeout) ||
  !Number.isFinite(keepAliveTimeout) ||
  keepAliveTimeout < 0
) {
  keepAliveTimeout = undefined;
}

const sessionsFilePath = path.join(dir, "data", "users", "sessions.json");

function readSessions() {
  try {
    const content = fs.readFileSync(sessionsFilePath, "utf-8");
    return JSON.parse(content) || {};
  } catch {
    return {};
  }
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx < 0) return;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    cookies[key] = val;
  });
  return cookies;
}

function authenticateWs(req) {
  const cookies = parseCookies(req.headers.cookie);
  const isHttps = process.env.HTTPS === "true";
  const sessionId = isHttps
    ? cookies["__Host-session"]
    : cookies["session"];

  if (!sessionId) return null;

  const sessions = readSessions();
  const username = sessions[sessionId];
  return username || null;
}

const connectedClients = new Map();

const wss = new WebSocketServer({ noServer: true });

// Dedicated WS server for Hocuspocus collaboration upgrades (/_ws/collab/*).
const collabWss = new WebSocketServer({ noServer: true });

function buildCollabFetchRequest(req) {
  // Hocuspocus expects a Fetch-API-like Request: it only reads `request.url`
  // (full URL string) and `request.headers` (Headers instance). Build a
  // minimal shim around the Node IncomingMessage.
  const proto =
    process.env.HTTPS === "true" || req.headers["x-forwarded-proto"] === "https"
      ? "https"
      : "http";
  const host = req.headers.host || "localhost";
  const fullUrl = `${proto}://${host}${req.url || "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      value.forEach((v) => headers.append(key, String(v)));
    } else if (value !== undefined) {
      headers.append(key, String(value));
    }
  }
  return { url: fullUrl, headers };
}

collabWss.on("connection", (ws, req) => {
  try {
    const { getCollabServer } = require("./app/_server/collab/server.cjs");
    const collab = getCollabServer();
    const fetchRequest = buildCollabFetchRequest(req);
    const clientConnection = collab.handleConnection(ws, fetchRequest);

    ws.on("message", (data) => {
      try {
        const buf =
          data instanceof Uint8Array
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data);
        clientConnection.handleMessage(
          buf instanceof Uint8Array ? buf : new Uint8Array(buf)
        );
      } catch (err) {
        console.error("Collab message error:", err);
      }
    });

    ws.on("close", (code, reason) => {
      try {
        clientConnection.handleClose({
          code,
          reason: reason ? reason.toString() : "",
        });
      } catch (err) {
        console.error("Collab close error:", err);
      }
    });

    ws.on("error", (err) => {
      console.error("Collab WS error:", err);
    });
  } catch (err) {
    console.error("Collab connection setup failed:", err);
    try {
      ws.close();
    } catch {}
  }
});

wss.on("connection", (ws, req) => {
  const connectionId = crypto.randomUUID();
  const username = req._wsUsername;

  connectedClients.set(ws, { connectionId, username });
  ws.send(JSON.stringify({ type: "connected", connectionId }));

  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("close", () => {
    connectedClients.delete(ws);
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      connectedClients.delete(ws);
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

setInterval(() => {
  for (const [ws] of connectedClients) {
    if (ws.readyState >= 2) connectedClients.delete(ws);
  }
}, 60000);

wss.on("close", () => {
  clearInterval(heartbeat);
});

globalThis.__jottyBroadcast = (event) => {
  const payload = JSON.stringify(event);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(payload);
    }
  });
};

globalThis.__jottyHasConnectedClients = () => connectedClients.size > 0;

const nextConfigStr = fs.readFileSync(
  path.join(nextDir, "required-server-files.json"),
  "utf-8"
);
const { config: nextConfig } = JSON.parse(nextConfigStr);

process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);

const next = require("next");
const app = next({ dev: false, dir, hostname, port: currentPort, conf: nextConfig });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    const parsedUrl = parse(req.url, true);
    await handle(req, res, parsedUrl);
  });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url);

    if (pathname && pathname.startsWith("/_ws/collab/")) {
      try {
        const username = authenticateWs(req);
        if (!username) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        // Eagerly initialize the singleton so any startup error surfaces
        // before the WS upgrade completes.
        require("./app/_server/collab/server.cjs").getCollabServer();
        collabWss.handleUpgrade(req, socket, head, (ws) => {
          collabWss.emit("connection", ws, req);
        });
      } catch (err) {
        console.error("Collab upgrade failed:", err);
        try {
          socket.destroy();
        } catch {}
      }
      return;
    }

    if (pathname === "/_ws") {
      const username = authenticateWs(req);
      if (!username) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      req._wsUsername = username;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  if (keepAliveTimeout) {
    server.keepAliveTimeout = keepAliveTimeout;
  }

  server.listen(currentPort, hostname, () => {
  console.log(`
   jjjj               .       .              
    jjj             .tt     .tt              
    jjj  .ooooo.  .tttttt .ttttt  yyyy    yyy
    jjj ooo' 'ooo   ttt     ttt    'yy.  .y' 
    jjj ooo   ooo   ttt     ttt     'yy..y'  
    jjj ooo   ooo   ttt .   ttt .    'yyY'   
.J. jjj 'OoooooO'   'ttt'   'ttt'     'y'    
'JJJJJ                            'y..y'     
                                  'YyY'      
  `);
    console.log(`> Ready on http://${hostname}:${currentPort}`);
  });
});
