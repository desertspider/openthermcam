"""Camera sources: the real camera (DirectShow) and a simulator."""

from .base import CameraSource, LiveState
from .simulator import SimulatedCamera


def create_camera(simulate: bool = False, device_name: str = "UVC Camera 0") -> CameraSource:
    if simulate:
        return SimulatedCamera()
    from .dshow import DirectShowCamera

    return DirectShowCamera(device_name=device_name)


__all__ = ["CameraSource", "LiveState", "SimulatedCamera", "create_camera"]
