#include "surevideotool/surevideotool_ids.h"

namespace surevideotool
{
    const GUID kVirtualCameraSourceClsid =
    { 0x3654e564, 0xb43f, 0x426a, { 0xa2, 0x82, 0x5b, 0x46, 0x46, 0xd0, 0x6d, 0x66 } };

    const GUID kWindowsVirtualCameraSourceClsid =
    { 0xe75cc3b2, 0x232f, 0x4fd5, { 0xaf, 0x67, 0xb3, 0xab, 0xb0, 0x11, 0xc2, 0x98 } };

    const wchar_t* const kVirtualCameraFriendlyName = L"Avatar Mimic Real Time";
    const wchar_t* const kPublisherMappingName = L"Local\\SurevideotoolCam.FrameBuffer";
    const wchar_t* const kPublisherMutexName = L"Local\\SurevideotoolCam.FrameMutex";
    const wchar_t* const kPublisherEventName = L"Local\\SurevideotoolCam.FrameEvent";
    const wchar_t* const kGlobalPublisherMappingName = L"Global\\SurevideotoolCam.FrameBuffer";
    const wchar_t* const kGlobalPublisherMutexName = L"Global\\SurevideotoolCam.FrameMutex";
    const wchar_t* const kGlobalPublisherEventName = L"Global\\SurevideotoolCam.FrameEvent";
    const wchar_t* const kMfPublisherBridgeDirectoryPath = L"C:\\Users\\Public\\Documents\\Avatar Mimic Real Time";
    const wchar_t* const kMfPublisherBridgeFilePath = L"C:\\Users\\Public\\Documents\\Avatar Mimic Real Time\\mf-bridge.bin";
}
