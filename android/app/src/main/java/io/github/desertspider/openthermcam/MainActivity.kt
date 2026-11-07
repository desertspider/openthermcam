package io.github.desertspider.openthermcam

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/**
 * Hosts the OpenThermCam web UI (bundled assets) in a WebView and bridges the USB camera to it.
 *
 * JS -> native: window.OTCNative.{connect, startCamera, stopCamera, shareFile}
 * native -> JS: a MessagePort ("otc-port") carrying frames as ArrayBuffer `[type] + payload`
 *               (or "b64:" strings on old WebViews) and camera status as JSON strings.
 */
class MainActivity : Activity() {
    companion object {
        private const val ORIGIN = "https://appassets.androidplatform.net"
        private const val START_URL = "$ORIGIN/assets/web/index.html"
        private const val ACTION_USB_PERMISSION = "io.github.desertspider.openthermcam.USB_PERMISSION"
        private const val REQUEST_FILES = 1
        private const val REQUEST_CAMERA = 2
    }

    private lateinit var webView: WebView
    private lateinit var usb: UsbManager
    private lateinit var camera: UvcCamera
    private val main = Handler(Looper.getMainLooper())
    private var port: WebMessagePortCompat? = null
    private var arrayBuffers = false
    private val inFlight = AtomicInteger(0)
    private var wantCamera = false
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var status = JSONObject().put("status", "waiting").put("message", "sluit de warmtecamera aan via USB-C")

    private val usbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_USB_PERMISSION ->
                    if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) startCamera()
                    else setStatus("error", "geen toestemming voor de USB-camera")
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> if (wantCamera) startCamera()
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    camera.stop()
                    setStatus("waiting", "camera losgekoppeld")
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        usb = getSystemService(UsbManager::class.java)
        camera = UvcCamera(usb, ::sendFrame) { s, m -> setStatus(s, m) }

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        WebView.setWebContentsDebuggingEnabled(true)
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            setBackgroundColor(0xFF0F1115.toInt())
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assets.shouldInterceptRequest(request.url)
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                    fileCallback?.onReceiveValue(null)
                    fileCallback = callback
                    val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                        type = "image/jpeg"
                        addCategory(Intent.CATEGORY_OPENABLE)
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                    startActivityForResult(Intent.createChooser(intent, "Radiometrische foto's"), REQUEST_FILES)
                    return true
                }
            }
            addJavascriptInterface(Bridge(), "OTCNative")
        }
        // Android 15 draws edge-to-edge: keep the UI clear of the status and navigation bars.
        // (A WebView ignores its own padding, so the insets go on a container around it.)
        val root = FrameLayout(this).apply {
            setBackgroundColor(0xFF171A21.toInt())
            addView(webView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        val filter = IntentFilter().apply {
            addAction(ACTION_USB_PERMISSION)
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        ContextCompat.registerReceiver(this, usbReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        webView.loadUrl(START_URL)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == UsbManager.ACTION_USB_DEVICE_ATTACHED && wantCamera) startCamera()
    }

    override fun onStop() {
        super.onStop()
        camera.stop() // release the camera when the app is in the background
    }

    override fun onStart() {
        super.onStart()
        if (wantCamera) startCamera()
    }

    override fun onDestroy() {
        unregisterReceiver(usbReceiver)
        camera.stop()
        webView.destroy()
        super.onDestroy()
    }

    @Deprecated("Activity result API is not used to keep dependencies minimal")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_FILES) return
        val uris = mutableListOf<Uri>()
        if (resultCode == RESULT_OK && data != null) {
            data.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) }
            if (uris.isEmpty()) data.data?.let(uris::add)
        }
        fileCallback?.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
        fileCallback = null
    }

    // ---- camera ---------------------------------------------------------------------------

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_CAMERA) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startCamera()
        else setStatus("error", "zonder cameratoestemming kan Android de USB-camera niet openen")
    }

    private fun startCamera() {
        wantCamera = true
        if (camera.isRunning) return
        // Android 9+ only lets apps open USB video (UVC) devices with the CAMERA permission.
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            setStatus("connecting", "toestemming voor de camera gevraagd")
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQUEST_CAMERA)
            return
        }
        val device: UsbDevice = camera.findDevice() ?: run {
            setStatus("waiting", "sluit de warmtecamera aan via USB-C")
            return
        }
        if (!usb.hasPermission(device)) {
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
            val pi = PendingIntent.getBroadcast(this, 0, Intent(ACTION_USB_PERMISSION).setPackage(packageName), flags)
            setStatus("connecting", "toestemming voor de camera gevraagd")
            usb.requestPermission(device, pi)
            return
        }
        Thread { camera.start(device) }.start()
    }

    private fun setStatus(s: String, message: String) {
        status = JSONObject().put("status", s).put("message", message)
        main.post { postStatus() }
    }

    private fun postStatus() {
        val json = JSONObject(status.toString())
            .put("temperature_frames", camera.temperatureFrames)
            .put("video_frames", camera.videoFrames)
        port?.postMessage(WebMessageCompat(json.toString()))
    }

    /** Called on the USB thread. Video frames are dropped when the WebView falls behind. */
    private fun sendFrame(type: Int, frame: ByteArray) {
        if (type == UvcCamera.TYPE_H264 && inFlight.get() > 3) return
        val msg = ByteArray(frame.size + 1)
        msg[0] = type.toByte()
        System.arraycopy(frame, 0, msg, 1, frame.size)
        inFlight.incrementAndGet()
        main.post {
            try {
                val p = port ?: return@post
                if (arrayBuffers) p.postMessage(WebMessageCompat(msg))
                else p.postMessage(WebMessageCompat("b64:" + Base64.encodeToString(msg, Base64.NO_WRAP)))
                if (type == UvcCamera.TYPE_TEMPERATURE) postStatus()
            } finally {
                inFlight.decrementAndGet()
            }
        }
    }

    private fun openPort() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE)
        ) {
            setStatus("error", "deze WebView-versie is te oud; update Android System WebView")
            return
        }
        arrayBuffers = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
        port?.close()
        val ports = WebViewCompat.createWebMessageChannel(webView)
        port = ports[0]
        WebViewCompat.postWebMessage(webView, WebMessageCompat("otc-port", arrayOf(ports[1])), Uri.parse(ORIGIN))
        postStatus()
    }

    private fun share(name: String, mime: String, base64: String) {
        val dir = File(cacheDir, "shared").apply { mkdirs() }
        val file = File(dir, name.replace(Regex("[^\\w.-]+"), "_"))
        file.writeBytes(Base64.decode(base64, Base64.DEFAULT))
        val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(intent, "Snapshot delen"))
    }

    /** Methods callable from JavaScript (they run on a binder thread). */
    inner class Bridge {
        @JavascriptInterface fun connect() = main.post { openPort() }.let { }
        @JavascriptInterface fun startCamera() = main.post { this@MainActivity.startCamera() }.let { }
        @JavascriptInterface fun stopCamera() = main.post { wantCamera = false; camera.stop() }.let { }
        @JavascriptInterface fun shareFile(name: String, mime: String, base64: String) =
            main.post { share(name, mime, base64) }.let { }
    }
}
