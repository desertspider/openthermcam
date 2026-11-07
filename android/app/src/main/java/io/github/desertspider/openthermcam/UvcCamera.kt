package io.github.desertspider.openthermcam

import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Log
import java.io.ByteArrayOutputStream

/**
 * Minimal UVC reader for the thermal camera (VID 0x1D6B, PID 0x1110).
 *
 * The camera streams over a bulk endpoint. Every UVC payload is a whole sample: either an
 * H.264 frame (256x342) or, about every 1.2 s, a temperature frame:
 * 10-byte marker FF00FF00FF00FF00FF00 + 192x256 uint16 LE in deci-kelvin. See docs/PROTOCOL.md.
 *
 * Frames are delivered to [onFrame] as `[type] + payload`, the same framing the PC server
 * uses on its WebSocket: type 1 = H.264, type 2 = temperature (without the marker).
 */
class UvcCamera(
    private val usb: UsbManager,
    private val onFrame: (type: Int, frame: ByteArray) -> Unit,
    private val onStatus: (status: String, message: String) -> Unit,
) {
    companion object {
        const val VENDOR_ID = 0x1D6B
        const val PRODUCT_ID = 0x1110
        const val TYPE_H264 = 1
        const val TYPE_TEMPERATURE = 2
        private const val TAG = "UvcCamera"
        private const val CC_VIDEO = 0x0E
        private const val SC_VIDEOSTREAMING = 0x02
        private const val SET_CUR = 0x01
        private const val GET_CUR = 0x81
        private const val VS_PROBE_CONTROL = 0x01
        private const val VS_COMMIT_CONTROL = 0x02
        private const val PROBE_LEN = 26
        private val TEMP_MARKER = byteArrayOf(0xFF.toByte(), 0, 0xFF.toByte(), 0, 0xFF.toByte(), 0, 0xFF.toByte(), 0, 0xFF.toByte(), 0)
        private const val TEMP_PIXELS_BYTES = 192 * 256 * 2
        const val TEMP_SAMPLE_SIZE = 10 + TEMP_PIXELS_BYTES
    }

    @Volatile var temperatureFrames = 0; private set
    @Volatile var videoFrames = 0; private set

    @Volatile private var running = false
    private var thread: Thread? = null
    private var connection: UsbDeviceConnection? = null
    private var streamingInterface: UsbInterface? = null

    val isRunning get() = running

    fun findDevice(): UsbDevice? =
        usb.deviceList.values.firstOrNull { it.vendorId == VENDOR_ID && it.productId == PRODUCT_ID }

    /** Open [device] (permission must already be granted) and start streaming on a background thread. */
    @Synchronized
    fun start(device: UsbDevice) {
        if (running) return
        val conn = usb.openDevice(device) ?: run {
            onStatus("error", "kan de camera niet openen")
            return
        }
        val (intf, ep) = findStreaming(device) ?: run {
            conn.close()
            onStatus("error", "geen UVC-videostream gevonden op dit apparaat")
            return
        }
        if (!conn.claimInterface(intf, true)) {
            conn.close()
            onStatus("error", "camera is in gebruik door een andere app")
            return
        }
        conn.setInterface(intf)
        val maxPayload = negotiate(conn, intf.id)
        if (maxPayload < 0) {
            conn.releaseInterface(intf)
            conn.close()
            onStatus("error", "camera accepteert de streaminstellingen niet")
            return
        }
        connection = conn
        streamingInterface = intf
        running = true
        onStatus("connecting", "wachten op beeld")
        thread = Thread({ readLoop(conn, ep) }, "uvc-reader").apply { start() }
    }

    @Synchronized
    fun stop() {
        running = false
        thread?.join(1500)
        thread = null
        val conn = connection
        val intf = streamingInterface
        if (conn != null && intf != null) {
            // SET_INTERFACE alt 0 stops the stream (this is what Windows does as well)
            conn.controlTransfer(0x01, 0x0B, 0, intf.id, null, 0, 500)
            conn.releaseInterface(intf)
            conn.close()
        }
        connection = null
        streamingInterface = null
    }

    private fun findStreaming(device: UsbDevice): Pair<UsbInterface, UsbEndpoint>? {
        for (i in 0 until device.interfaceCount) {
            val intf = device.getInterface(i)
            if (intf.interfaceClass != CC_VIDEO || intf.interfaceSubclass != SC_VIDEOSTREAMING) continue
            for (e in 0 until intf.endpointCount) {
                val ep = intf.getEndpoint(e)
                if (ep.direction == UsbConstants.USB_DIR_IN && ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK) return intf to ep
            }
        }
        return null
    }

    /** UVC probe/commit for format 1 / frame 1 at 30 fps. Returns dwMaxPayloadTransferSize or -1. */
    private fun negotiate(conn: UsbDeviceConnection, ifNum: Int): Int {
        val probe = ByteArray(PROBE_LEN)
        conn.controlTransfer(0xA1, GET_CUR, VS_PROBE_CONTROL shl 8, ifNum, probe, PROBE_LEN, 1000)
        probe[0] = 1; probe[1] = 0 // bmHint: keep dwFrameInterval
        probe[2] = 1 // bFormatIndex (H.264)
        probe[3] = 1 // bFrameIndex (256x342)
        putInt(probe, 4, 333_333) // 30 fps in 100 ns units
        if (conn.controlTransfer(0x21, SET_CUR, VS_PROBE_CONTROL shl 8, ifNum, probe, PROBE_LEN, 1000) < 0) return -1
        val agreed = ByteArray(PROBE_LEN)
        if (conn.controlTransfer(0xA1, GET_CUR, VS_PROBE_CONTROL shl 8, ifNum, agreed, PROBE_LEN, 1000) < PROBE_LEN) {
            System.arraycopy(probe, 0, agreed, 0, PROBE_LEN)
        }
        if (conn.controlTransfer(0x21, SET_CUR, VS_COMMIT_CONTROL shl 8, ifNum, agreed, PROBE_LEN, 1000) < 0) return -1
        val maxPayload = getInt(agreed, 22)
        Log.i(TAG, "UVC committed, max payload $maxPayload")
        return maxPayload
    }

    private fun readLoop(conn: UsbDeviceConnection, ep: UsbEndpoint) {
        // Android < 9 limits a single bulk transfer to 16 KB; payloads then span several reads.
        val chunk = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) 512 * 1024 else 16 * 1024
        val buf = ByteArray(chunk)
        val payload = ByteArrayOutputStream(256 * 1024)
        val frame = ByteArrayOutputStream(128 * 1024)
        var lastFid = -1
        var failures = 0
        var streaming = false
        while (running) {
            val n = conn.bulkTransfer(ep, buf, chunk, 1000)
            if (n < 0) {
                if (++failures > 5) {
                    onStatus("waiting", "geen beeld van de camera")
                    streaming = false
                    failures = 0
                }
                continue
            }
            failures = 0
            if (n > 0) payload.write(buf, 0, n)
            if (n == chunk) continue // payload continues in the next transfer
            // short (or zero-length) transfer: end of one UVC payload
            val p = payload.toByteArray()
            payload.reset()
            if (p.size < 2) continue
            val headerLen = p[0].toInt() and 0xFF
            val flags = p[1].toInt() and 0xFF
            if (headerLen < 2 || headerLen > p.size) continue
            val fid = flags and 0x01
            if (lastFid != -1 && fid != lastFid && frame.size() > 0) emit(frame)
            lastFid = fid
            frame.write(p, headerLen, p.size - headerLen)
            if (flags and 0x02 != 0) emit(frame) // end of frame
            if (!streaming && temperatureFrames + videoFrames > 0) {
                streaming = true
                onStatus("streaming", "")
            }
        }
    }

    private fun emit(frame: ByteArrayOutputStream) {
        val data = frame.toByteArray()
        frame.reset()
        when {
            data.size >= TEMP_SAMPLE_SIZE && startsWith(data, TEMP_MARKER) -> {
                temperatureFrames++
                onFrame(TYPE_TEMPERATURE, data.copyOfRange(10, TEMP_SAMPLE_SIZE))
            }
            data.size > 4 && data[0].toInt() == 0 && data[1].toInt() == 0 &&
                (data[2].toInt() == 1 || (data[2].toInt() == 0 && data[3].toInt() == 1)) -> {
                videoFrames++
                onFrame(TYPE_H264, data)
            }
            // anything else (e.g. the occasional all-zero sample) is ignored
        }
    }

    private fun startsWith(a: ByteArray, prefix: ByteArray): Boolean {
        for (i in prefix.indices) if (a[i] != prefix[i]) return false
        return true
    }

    private fun putInt(b: ByteArray, off: Int, v: Int) {
        b[off] = v.toByte(); b[off + 1] = (v shr 8).toByte(); b[off + 2] = (v shr 16).toByte(); b[off + 3] = (v shr 24).toByte()
    }

    private fun getInt(b: ByteArray, off: Int): Int =
        (b[off].toInt() and 0xFF) or ((b[off + 1].toInt() and 0xFF) shl 8) or
            ((b[off + 2].toInt() and 0xFF) shl 16) or ((b[off + 3].toInt() and 0xFF) shl 24)
}
