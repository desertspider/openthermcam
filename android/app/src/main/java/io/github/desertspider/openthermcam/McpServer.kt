package io.github.desertspider.openthermcam

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.security.MessageDigest

/**
 * Minimal MCP server ("Streamable HTTP" transport, JSON responses only) so an AI assistant on
 * another computer can read and analyse the snapshots on this phone.
 *
 *   POST http://<phone-ip>:<port>/mcp   with   Authorization: Bearer <key>
 *
 * initialize / ping are answered here; tools/list and tools/call are forwarded to the web UI
 * through [dispatch] (the library lives in the WebView), which blocks until JS replies.
 */
class McpServer(
    private val port: Int,
    private val key: String,
    private val dispatch: (method: String, params: JSONObject) -> JSONObject,
) {
    companion object {
        private const val TAG = "McpServer"
        private val SUPPORTED_VERSIONS = listOf("2025-06-18", "2025-03-26", "2024-11-05")
        private const val INSTRUCTIONS =
            "OpenThermCam on an Android phone: thermal snapshots taken with a USB thermal camera " +
                "(192x256 pixels, portrait). Temperatures are in degrees Celsius. Coordinates are matrix pixels: " +
                "x = column 0..191, y = row 0..255. Measurement points have a name and kind 'point' (x, y) or " +
                "'rect' (x, y, w, h); points with the same name on different snapshots are compared and form a trend. " +
                "Look at get_snapshot_image before placing points."

        fun addresses(): List<String> = NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList() }
            .filterIsInstance<Inet4Address>()
            .map { it.hostAddress ?: "" }
            .filter { it.isNotEmpty() && !it.startsWith("169.254.") }
    }

    @Volatile private var socket: ServerSocket? = null
    val running get() = socket?.isClosed == false

    fun start() {
        if (running) return
        val server = ServerSocket(port)
        socket = server
        Thread({
            while (!server.isClosed) {
                val client = try { server.accept() } catch (e: SocketException) { break }
                Thread({ handle(client) }, "mcp-client").start()
            }
        }, "mcp-accept").start()
        Log.i(TAG, "listening on $port")
    }

    fun stop() {
        socket?.close()
        socket = null
    }

    private fun handle(client: Socket) {
        client.use { s ->
            s.soTimeout = 30_000
            val input = BufferedInputStream(s.getInputStream())
            val out = s.getOutputStream()
            fun respond(status: Int, reason: String, body: String = "", extra: Map<String, String> = emptyMap()) {
                val bytes = body.toByteArray()
                val head = buildString {
                    append("HTTP/1.1 $status $reason\r\n")
                    if (bytes.isNotEmpty()) append("Content-Type: application/json\r\n")
                    append("Content-Length: ${bytes.size}\r\nConnection: close\r\n")
                    extra.forEach { (k, v) -> append("$k: $v\r\n") }
                    append("\r\n")
                }
                out.write(head.toByteArray())
                out.write(bytes)
                out.flush()
            }
            try {
                val requestLine = readLine(input) ?: return
                val headers = mutableMapOf<String, String>()
                while (true) {
                    val line = readLine(input) ?: return
                    if (line.isEmpty()) break
                    val i = line.indexOf(':')
                    if (i > 0) headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
                }
                val parts = requestLine.split(" ")
                val method = parts.getOrNull(0) ?: ""
                val path = parts.getOrNull(1)?.substringBefore('?') ?: ""
                if (path != "/mcp") return respond(404, "Not Found", """{"error":"use /mcp"}""")
                if (!authorized(headers["authorization"])) {
                    return respond(401, "Unauthorized", """{"error":"missing or wrong key"}""",
                        mapOf("WWW-Authenticate" to "Bearer"))
                }
                when (method) {
                    "POST" -> {}
                    "DELETE" -> return respond(200, "OK") // session end: nothing to clean up
                    else -> return respond(405, "Method Not Allowed", "", mapOf("Allow" to "POST, DELETE"))
                }
                val length = headers["content-length"]?.toIntOrNull() ?: 0
                if (length <= 0 || length > 1_000_000) return respond(400, "Bad Request", """{"error":"body required"}""")
                val body = String(readExactly(input, length))
                val parsed = body.trim()
                if (parsed.startsWith("[")) {
                    val batch = JSONArray(parsed)
                    val replies = JSONArray()
                    for (k in 0 until batch.length()) rpc(batch.getJSONObject(k))?.let(replies::put)
                    return if (replies.length() == 0) respond(202, "Accepted") else respond(200, "OK", replies.toString())
                }
                val reply = rpc(JSONObject(parsed)) ?: return respond(202, "Accepted")
                respond(200, "OK", reply.toString())
            } catch (e: Exception) {
                Log.w(TAG, "request failed", e)
                runCatching { respond(400, "Bad Request", JSONObject().put("error", e.message ?: "bad request").toString()) }
            }
        }
    }

    /** Handle one JSON-RPC message; returns null for notifications. */
    private fun rpc(msg: JSONObject): JSONObject? {
        if (!msg.has("id")) return null
        val id = msg.get("id")
        val method = msg.optString("method")
        val params = msg.optJSONObject("params") ?: JSONObject()
        val reply = JSONObject().put("jsonrpc", "2.0").put("id", id)
        return try {
            val result = when (method) {
                "initialize" -> {
                    val wanted = params.optString("protocolVersion")
                    JSONObject()
                        .put("protocolVersion", if (wanted in SUPPORTED_VERSIONS) wanted else SUPPORTED_VERSIONS[0])
                        .put("capabilities", JSONObject().put("tools", JSONObject()))
                        .put("serverInfo", JSONObject().put("name", "openthermcam-android").put("version", "0.1.0"))
                        .put("instructions", INSTRUCTIONS)
                }
                "ping" -> JSONObject()
                "tools/list", "tools/call" -> dispatch(method, params)
                else -> return reply.put("error", JSONObject().put("code", -32601).put("message", "Method not found: $method"))
            }
            reply.put("result", result)
        } catch (e: Exception) {
            reply.put("error", JSONObject().put("code", -32603).put("message", e.message ?: "internal error"))
        }
    }

    private fun authorized(header: String?): Boolean {
        val given = header?.removePrefix("Bearer ")?.trim() ?: return false
        return MessageDigest.isEqual(given.toByteArray(), key.toByteArray())
    }

    private fun readLine(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b == -1) return if (buf.size() == 0) null else buf.toString()
            if (b == '\n'.code) return buf.toString().trimEnd('\r')
            buf.write(b)
            if (buf.size() > 16_384) throw IllegalStateException("header line too long")
        }
    }

    private fun readExactly(input: InputStream, n: Int): ByteArray {
        val data = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = input.read(data, off, n - off)
            if (r < 0) throw IllegalStateException("connection closed")
            off += r
        }
        return data
    }
}
