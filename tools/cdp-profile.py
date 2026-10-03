"""极简 CDP 客户端（RFC6455 掩码帧，只够用来 evaluate）。"""
import base64, json, os, socket, struct, sys, time, urllib.request

class CDP:
    def __init__(self, port=9333):
        for _ in range(60):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as r:
                    targets = json.load(r)
                pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
                if pages:
                    self.ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            raise SystemExit("连不上调试端口")
        url = self.ws_url.replace("ws://", "")
        hostport, path = url.split("/", 1)
        host, port = hostport.split(":")
        self.sock = socket.create_connection((host, int(port)), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        self.buf = buf.split(b"\r\n\r\n", 1)[1]
        self.msg_id = 0

    def _recv(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("连接已断开")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _frame(self, payload: bytes):
        mask = os.urandom(4)
        n = len(payload)
        header = bytearray([0x81])
        if n < 126: header.append(0x80 | n)
        elif n < 65536: header.append(0x80 | 126); header += struct.pack(">H", n)
        else: header.append(0x80 | 127); header += struct.pack(">Q", n)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def _read_frame(self):
        b1, b2 = self._recv(2)
        n = b2 & 0x7F
        if n == 126: n = struct.unpack(">H", self._recv(2))[0]
        elif n == 127: n = struct.unpack(">Q", self._recv(8))[0]
        if b2 & 0x80: self._recv(4)
        return self._recv(n)

    def send(self, method, params=None):
        self.msg_id += 1
        mid = self.msg_id
        self._frame(json.dumps({"id": mid, "method": method, "params": params or {}}).encode())
        while True:
            msg = json.loads(self._read_frame())
            if msg.get("id") == mid:
                return msg

    def evaluate(self, expression, await_promise=True):
        r = self.send("Runtime.evaluate", {"expression": expression, "awaitPromise": await_promise,
                                           "returnByValue": True, "timeout": 120000})
        res = r.get("result", {}).get("result", {})
        if "value" in res: return res["value"]
        return r.get("result", {}).get("exceptionDetails", {}).get("text") or res

def profile(chat_file, char_name, seconds=15, out="/tmp/cdp-profile.json"):
    """打开指定角色的聊天并采集 CPU profile（带函数名）。"""
    c = CDP()
    c.send("Profiler.enable")
    c.send("Profiler.setSamplingInterval", {"interval": 400})   # 0.4ms 采样
    c.send("Profiler.start")
    opened = c.evaluate(f"""(async () => {{
        const ctx = SillyTavern.getContext();
        const ch = ctx.characters.find((x) => x.name === {json.dumps(char_name)});
        if (!ch) return '角色未找到';
        await ctx.selectCharacterById(ch.id);
        await new Promise((r) => setTimeout(r, 500));
        await ctx.openCharacterChat({json.dumps(chat_file)});
        return 'opened';
    }})()""")
    print(f"  触发结果: {opened}")
    time.sleep(seconds)
    result = c.send("Profiler.stop")
    profile_data = result.get("result", {}).get("profile", {})
    with open(out, "w", encoding="utf-8") as f:
        json.dump(profile_data, f)
    print(f"  已保存 profile: {out}（{len(profile_data.get('samples', []))} 个采样）")
    return out


if __name__ == "__main__":
    if sys.argv[1] == "profile":
        profile(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 15)
    else:
        c = CDP()
        print(c.evaluate(sys.argv[1]))
