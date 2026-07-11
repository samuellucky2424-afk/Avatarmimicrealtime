#include <windows.h>

#include <fcntl.h>
#include <io.h>

#include <cstdint>
#include <cstring>
#include <iostream>
#include <vector>

#include "surevideotool/surevideotool_publisher.h"

namespace
{
    constexpr uint32_t kPipeProtocolMagic = 0x5041434d;
    constexpr uint32_t kPipeProtocolVersion = 1;

    struct PipeFrameHeader
    {
        uint32_t magic = kPipeProtocolMagic;
        uint32_t version = kPipeProtocolVersion;
        uint32_t width = 0;
        uint32_t height = 0;
        uint32_t stride = 0;
        uint32_t fpsNumerator = 0;
        uint32_t fpsDenominator = 1;
        uint32_t payloadBytes = 0;
        int64_t timestampHundredsOfNs = 0;
    };

    static_assert(sizeof(PipeFrameHeader) == 40, "PipeFrameHeader must stay stable.");

    int64_t GetTimestampHundredsOfNs()
    {
        FILETIME fileTime{};
        GetSystemTimePreciseAsFileTime(&fileTime);

        ULARGE_INTEGER value{};
        value.LowPart = fileTime.dwLowDateTime;
        value.HighPart = fileTime.dwHighDateTime;
        return static_cast<int64_t>(value.QuadPart);
    }

    bool ReadExact(std::istream* input, void* buffer, size_t byteCount)
    {
        if (input == nullptr || buffer == nullptr)
        {
            return false;
        }

        input->read(static_cast<char*>(buffer), static_cast<std::streamsize>(byteCount));
        return static_cast<size_t>(input->gcount()) == byteCount;
    }

    bool NeedsReopen(const surevideotool::PublisherConfig& currentConfig, const surevideotool::PublisherConfig& nextConfig, bool isOpen)
    {
        return !isOpen
            || currentConfig.width != nextConfig.width
            || currentConfig.height != nextConfig.height
            || currentConfig.stride != nextConfig.stride
            || currentConfig.fpsNumerator != nextConfig.fpsNumerator
            || currentConfig.fpsDenominator != nextConfig.fpsDenominator;
    }

    bool ValidateHeader(const PipeFrameHeader& header)
    {
        if (header.magic != kPipeProtocolMagic || header.version != kPipeProtocolVersion)
        {
            return false;
        }

        if (header.width == 0 || header.height == 0 || header.stride < (header.width * 4))
        {
            return false;
        }

        if (header.fpsNumerator == 0 || header.fpsDenominator == 0)
        {
            return false;
        }

        const uint64_t expectedBytes = static_cast<uint64_t>(header.stride) * header.height;
        return expectedBytes == header.payloadBytes;
    }

    bool IsRetryableOpenError(HRESULT hr)
    {
        switch (HRESULT_CODE(hr))
        {
        case ERROR_ACCESS_DENIED:
        case ERROR_FILE_NOT_FOUND:
        case ERROR_INVALID_HANDLE:
        case ERROR_PATH_NOT_FOUND:
        case ERROR_PRIVILEGE_NOT_HELD:
            return true;
        default:
            return false;
        }
    }
}

int wmain()
{
    if (_setmode(_fileno(stdin), _O_BINARY) == -1)
    {
        std::cerr << "Failed to switch stdin to binary mode.\n";
        return 1;
    }

    surevideotool::Publisher publisher;
    surevideotool::PublisherConfig currentConfig{};
    bool isOpen = false;
    bool waitingForBridge = false;
    std::vector<uint8_t> frameBytes;

    for (;;)
    {
        PipeFrameHeader header{};
        std::cin.read(reinterpret_cast<char*>(&header), static_cast<std::streamsize>(sizeof(header)));

        const auto headerBytesRead = static_cast<size_t>(std::cin.gcount());
        if (headerBytesRead == 0 && std::cin.eof())
        {
            break;
        }

        if (headerBytesRead != sizeof(header))
        {
            std::cerr << "Unexpected end of stream while reading frame header.\n";
            return 1;
        }

        if (!ValidateHeader(header))
        {
            std::cerr << "Invalid frame header received.\n";
            return 1;
        }

        surevideotool::PublisherConfig nextConfig{};
        nextConfig.width = header.width;
        nextConfig.height = header.height;
        nextConfig.stride = header.stride;
        nextConfig.fpsNumerator = header.fpsNumerator;
        nextConfig.fpsDenominator = header.fpsDenominator;

        frameBytes.resize(header.payloadBytes);
        if (!ReadExact(&std::cin, frameBytes.data(), frameBytes.size()))
        {
            std::cerr << "Unexpected end of stream while reading frame payload.\n";
            return 1;
        }

        if (NeedsReopen(currentConfig, nextConfig, isOpen))
        {
            publisher.Close();
            isOpen = false;

            const HRESULT openHr = publisher.Open(nextConfig);
            if (FAILED(openHr))
            {
                if (IsRetryableOpenError(openHr))
                {
                    if (!waitingForBridge)
                    {
                        std::cerr << "Waiting for the Avatar Mimic Real Time virtual camera bridge to become available.\n";
                        waitingForBridge = true;
                    }

                    continue;
                }

                std::cerr << "Failed to open Avatar Mimic Real Time publisher. HRESULT=0x" << std::hex << static_cast<unsigned long>(openHr) << "\n";
                return 1;
            }

            currentConfig = nextConfig;
            isOpen = true;

            if (waitingForBridge)
            {
                std::cerr << "Avatar Mimic Real Time virtual camera bridge connected.\n";
                waitingForBridge = false;
            }
        }

        const int64_t timestampHundredsOfNs = header.timestampHundredsOfNs == 0
            ? GetTimestampHundredsOfNs()
            : header.timestampHundredsOfNs;

        const HRESULT publishHr = publisher.PublishBgraFrame(frameBytes.data(), frameBytes.size(), timestampHundredsOfNs);
        if (FAILED(publishHr))
        {
            std::cerr << "Failed to publish frame. HRESULT=0x" << std::hex << static_cast<unsigned long>(publishHr) << "\n";
            return 1;
        }
    }

    publisher.Close();
    return 0;
}
