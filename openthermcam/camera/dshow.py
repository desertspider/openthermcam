"""DirectShow capture of the camera's raw (still compressed) UVC samples.

Why DirectShow and not Media Foundation: Media Foundation's source reader drops the
camera's in-band temperature samples (they are not valid H.264). DirectShow with a
Sample Grabber that accepts the native H.264 media type passes every sample through.

Graph: [UVC source] -> [Sample Grabber (callback)] -> [Null Renderer]

Pure ctypes, no compiled dependencies. Windows only.
"""

from __future__ import annotations

import ctypes
import sys
import threading
import time
import uuid
from ctypes import HRESULT, POINTER, byref, c_double, c_long, c_uint32, c_void_p, c_wchar_p

from .base import CameraSource

if sys.platform != "win32":  # pragma: no cover
    raise ImportError("DirectShow capture is only available on Windows")


class GUID(ctypes.Structure):
    _fields_ = [("data", ctypes.c_ubyte * 16)]

    def __init__(self, text: str = "00000000-0000-0000-0000-000000000000") -> None:
        super().__init__()
        ctypes.memmove(self.data, uuid.UUID(text).bytes_le, 16)

    def __str__(self) -> str:
        return str(uuid.UUID(bytes_le=bytes(self.data)))


class VARIANT(ctypes.Structure):
    _fields_ = [("vt", ctypes.c_ushort), ("r", ctypes.c_ushort * 3), ("p", c_void_p), ("p2", c_void_p)]


CLSID_SystemDeviceEnum = "62BE5D10-60EB-11d0-BD3B-00A0C911CE86"
IID_ICreateDevEnum = "29840822-5B84-11D0-BD3B-00A0C911CE86"
CLSID_VideoInputDeviceCategory = "860BB310-5D01-11d0-BD3B-00A0C911CE86"
IID_IPropertyBag = "55272A00-42CB-11CE-8135-00AA004BB851"
CLSID_FilterGraph = "e436ebb3-524f-11ce-9f53-0020af0ba770"
IID_IGraphBuilder = "56a868a9-0ad4-11ce-b03a-0020af0ba770"
CLSID_CaptureGraphBuilder2 = "BF87B6E1-8C27-11d0-B3F0-00AA003761C5"
IID_ICaptureGraphBuilder2 = "93E5A4E0-2D50-11d2-ABFA-00A0C9C6E38D"
IID_IBaseFilter = "56a86895-0ad4-11ce-b03a-0020af0ba770"
CLSID_SampleGrabber = "C1F400A0-3F08-11d3-9F0B-006008039E37"
IID_ISampleGrabber = "6B652FFF-11FE-4fce-92AD-0266B5D7C78F"
IID_ISampleGrabberCB = "0579154A-2B53-4994-B0D0-E773148EFF85"
IID_IUnknown = "00000000-0000-0000-C000-000000000046"
CLSID_NullRenderer = "C1F400A4-3F08-11d3-9F0B-006008039E37"
IID_IMediaControl = "56a868b1-0ad4-11ce-b03a-0020af0ba770"
PIN_CATEGORY_CAPTURE = "fb6c4281-0353-11d1-905f-0000c0cc16ba"
MEDIATYPE_Video = "73646976-0000-0010-8000-00AA00389B71"

S_OK = 0
E_NOINTERFACE = 0x80004002 - 0x100000000

_ole32 = ctypes.windll.ole32
_oleaut32 = ctypes.windll.oleaut32


def _vcall(obj: c_void_p, index: int, argtypes: list, *args) -> int:
    """Call method ``index`` of a COM interface pointer; returns the HRESULT (unsigned)."""
    vtbl = ctypes.cast(ctypes.cast(obj, POINTER(c_void_p))[0], POINTER(c_void_p))
    fn = ctypes.WINFUNCTYPE(HRESULT, c_void_p, *argtypes)(vtbl[index])
    try:
        return fn(obj, *args) & 0xFFFFFFFF
    except OSError as exc:  # ctypes raises for failing HRESULTs
        return (exc.winerror or 0x80004005) & 0xFFFFFFFF


def _release(obj: c_void_p | None) -> None:
    if obj and obj.value:
        _vcall(obj, 2, [])


def _create(clsid: str, iid: str) -> c_void_p:
    ptr = c_void_p()
    hr = _ole32.CoCreateInstance(byref(GUID(clsid)), None, 1, byref(GUID(iid)), byref(ptr))
    if hr != 0:
        raise OSError(f"CoCreateInstance {clsid} failed: 0x{hr & 0xFFFFFFFF:08x}")
    return ptr


def _query(obj: c_void_p, iid: str) -> c_void_p:
    ptr = c_void_p()
    hr = _vcall(obj, 0, [POINTER(GUID), POINTER(c_void_p)], byref(GUID(iid)), byref(ptr))
    if hr != 0:
        raise OSError(f"QueryInterface {iid} failed: 0x{hr:08x}")
    return ptr


def list_video_devices() -> list[str]:
    """Friendly names of DirectShow video capture devices (call from a COM-initialised thread)."""
    return [name for name, mk in _enum_devices(release=True)]


def _enum_devices(release: bool):
    devenum = _create(CLSID_SystemDeviceEnum, IID_ICreateDevEnum)
    enum_mk = c_void_p()
    hr = _vcall(
        devenum, 3, [POINTER(GUID), POINTER(c_void_p), c_uint32],
        byref(GUID(CLSID_VideoInputDeviceCategory)), byref(enum_mk), 0,
    )
    result = []
    if hr == S_OK and enum_mk.value:
        while True:
            mk = c_void_p()
            fetched = c_uint32()
            if _vcall(enum_mk, 3, [c_uint32, POINTER(c_void_p), POINTER(c_uint32)], 1, byref(mk), byref(fetched)) != S_OK or not fetched.value:
                break
            bag = c_void_p()
            name = ""
            if _vcall(mk, 9, [c_void_p, c_void_p, POINTER(GUID), POINTER(c_void_p)], None, None, byref(GUID(IID_IPropertyBag)), byref(bag)) == S_OK:
                var = VARIANT()
                var.vt = 8  # VT_BSTR
                if _vcall(bag, 3, [c_wchar_p, POINTER(VARIANT), c_void_p], "FriendlyName", byref(var), None) == S_OK and var.p:
                    name = ctypes.wstring_at(var.p)
                    _oleaut32.SysFreeString(c_void_p(var.p))
                _release(bag)
            if release:
                _release(mk)
            result.append((name, mk))
        _release(enum_mk)
    _release(devenum)
    return result


# --- ISampleGrabberCB implemented in ctypes ----------------------------------

_QI = ctypes.WINFUNCTYPE(HRESULT, c_void_p, POINTER(GUID), POINTER(c_void_p))
_ADDREF = ctypes.WINFUNCTYPE(c_uint32, c_void_p)
_SAMPLECB = ctypes.WINFUNCTYPE(HRESULT, c_void_p, c_double, c_void_p)
_BUFFERCB = ctypes.WINFUNCTYPE(HRESULT, c_void_p, c_double, POINTER(ctypes.c_ubyte), c_long)


class _CBVtbl(ctypes.Structure):
    _fields_ = [
        ("QueryInterface", _QI),
        ("AddRef", _ADDREF),
        ("Release", _ADDREF),
        ("SampleCB", _SAMPLECB),
        ("BufferCB", _BUFFERCB),
    ]


class _CBObject(ctypes.Structure):
    _fields_ = [("lpVtbl", POINTER(_CBVtbl))]


class _GrabberCallback:
    """A static COM object whose BufferCB forwards a copy of each sample to ``on_sample``."""

    def __init__(self, on_sample) -> None:
        self._on_sample = on_sample
        accepted = {str(GUID(IID_IUnknown)), str(GUID(IID_ISampleGrabberCB))}

        def qi(this, riid, ppv):
            if str(riid.contents) in accepted:
                ppv[0] = this
                return S_OK
            ppv[0] = None
            return E_NOINTERFACE

        def addref(this):
            return 2

        def buffer_cb(this, sample_time, buf, length):
            if length > 0:
                try:
                    self._on_sample(ctypes.string_at(buf, length))
                except Exception:
                    pass
            return S_OK

        self._vtbl = _CBVtbl(_QI(qi), _ADDREF(addref), _ADDREF(addref), _SAMPLECB(lambda *a: S_OK), _BUFFERCB(buffer_cb))
        self._obj = _CBObject(ctypes.pointer(self._vtbl))
        self.pointer = c_void_p(ctypes.addressof(self._obj))


# --- camera ------------------------------------------------------------------


class DirectShowCamera(CameraSource):
    """Streams raw samples from the named UVC device; reconnects automatically."""

    def __init__(self, device_name: str = "UVC Camera 0", stall_timeout: float = 5.0) -> None:
        super().__init__()
        self.device_name = device_name
        self.stall_timeout = stall_timeout
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_sample = 0.0

    def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="dshow-camera", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        self.set_status("stopped")

    def _sample(self, data: bytes) -> None:
        self._last_sample = time.time()
        self._on_sample(data)

    def _run(self) -> None:
        _ole32.CoInitializeEx(None, 0)  # COINIT_MULTITHREADED
        callback = _GrabberCallback(self._sample)
        try:
            while not self._stop.is_set():
                try:
                    self._stream_once(callback)
                except Exception as exc:
                    self.set_status("error", str(exc))
                if not self._stop.is_set():
                    self._stop.wait(2.0)
        finally:
            _ole32.CoUninitialize()

    def _stream_once(self, callback: _GrabberCallback) -> None:
        self.set_status("connecting", f"zoeken naar '{self.device_name}'")
        source = None
        for name, mk in _enum_devices(release=False):
            if source is None and name == self.device_name:
                source = c_void_p()
                hr = _vcall(mk, 8, [c_void_p, c_void_p, POINTER(GUID), POINTER(c_void_p)], None, None, byref(GUID(IID_IBaseFilter)), byref(source))
                if hr != S_OK:
                    source = None
            _release(mk)
        if source is None:
            self.set_status("waiting", f"camera '{self.device_name}' niet gevonden; sluit hem aan en zet hem aan")
            return

        objs: list[c_void_p] = [source]
        control = None
        try:
            graph = _create(CLSID_FilterGraph, IID_IGraphBuilder)
            objs.append(graph)
            builder = _create(CLSID_CaptureGraphBuilder2, IID_ICaptureGraphBuilder2)
            objs.append(builder)
            _vcall(builder, 3, [c_void_p], graph)  # SetFiltergraph
            grab_filter = _create(CLSID_SampleGrabber, IID_IBaseFilter)
            objs.append(grab_filter)
            grabber = _query(grab_filter, IID_ISampleGrabber)
            objs.append(grabber)
            null = _create(CLSID_NullRenderer, IID_IBaseFilter)
            objs.append(null)
            for flt, name in ((source, "camera"), (grab_filter, "grabber"), (null, "null")):
                hr = _vcall(graph, 3, [c_void_p, c_wchar_p], flt, name)  # AddFilter
                if hr != S_OK:
                    raise OSError(f"AddFilter {name}: 0x{hr:08x}")
            _vcall(grabber, 6, [ctypes.c_int], 0)  # SetBufferSamples(FALSE)
            _vcall(grabber, 9, [c_void_p, ctypes.c_long], callback.pointer, 1)  # SetCallback(BufferCB)
            hr = _vcall(
                builder, 7, [POINTER(GUID), POINTER(GUID), c_void_p, c_void_p, c_void_p],
                byref(GUID(PIN_CATEGORY_CAPTURE)), byref(GUID(MEDIATYPE_Video)), source, grab_filter, null,
            )
            if hr != S_OK:
                raise OSError(f"RenderStream: 0x{hr:08x}")
            control = _query(graph, IID_IMediaControl)
            hr = _vcall(control, 7, [])  # Run
            if hr not in (0, 1):
                raise OSError(f"camera kan niet starten (0x{hr:08x}); is een ander programma nog met de camera verbonden?")
            self._last_sample = time.time()
            self.set_status("connecting", "wachten op beeld")
            while not self._stop.wait(0.5):
                if time.time() - self._last_sample > self.stall_timeout:
                    self.set_status("waiting", "geen beeld van de camera; opnieuw verbinden")
                    break
        finally:
            if control is not None:
                _vcall(control, 9, [])  # Stop
                _release(control)
            if len(objs) > 4:
                _vcall(objs[4], 9, [c_void_p, ctypes.c_long], None, 1)  # clear callback
            for obj in reversed(objs):
                _release(obj)
