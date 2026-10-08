# Multi-Receiver WebRTC Changes

## Scope

This document records the implementation work completed during the multi-receiver WebRTC session.

The target architecture is:

```text
ROS 2 image topic
        |
        v
single encoder and RTP payloader
        |
        v
      RTP tee
       /   \
      /     \
receiver A  receiver B
queue       queue
webrtcbin   webrtcbin
```

The video is encoded once per stream. Each receiver gets an independent WebRTC transport and signaling session.

## Sender Pipeline Changes

### Shared encoder and RTP tee

`sender/gst_pipeline.py` no longer creates one static `webrtcbin` directly after each encoder/payloader chain.

Each stream now creates:

```text
appsrc -> videoconvert -> encoder -> RTP payloader -> tee
```

The encoder and payloader are shared by all receivers.

### Permanent fallback branch

Every tee has a permanent discard branch:

```text
tee -> queue -> fakesink
```

The fallback uses `sync=false` and `async=false`.

This prevents the upstream pipeline from failing with:

```text
Internal data stream error
streaming stopped, reason not-linked (-1)
```

That error occurred when frames arrived before any receiver branch had been created.

### Dynamic receiver branches

When a receiver joins, the sender dynamically adds:

```text
tee -> bounded leaky queue -> capsfilter -> webrtcbin
```

The queue is configured with a maximum of 30 buffers and drops old buffers downstream when necessary. This prevents a slow receiver from blocking the shared encoder or affecting other receivers.

The `capsfilter` constrains each branch to the stream's RTP media type, codec, payload type, and clock rate.

### Receiver branch cleanup

When a receiver leaves, only that receiver's queue, capsfilter, `webrtcbin`, and requested pads are removed. The shared encoder and all other receiver branches remain active.

Branch names use a monotonically increasing sequence instead of the current branch count. This prevents GStreamer element-name collisions after reconnects.

Branch creation is transactional. If adding or linking an element fails, all elements and requested pads created during that attempt are rolled back.

## WebRTC Sender State Changes

### Per-receiver ownership

`sender/webrtc_sender.py` now tracks WebRTC objects using `(receiver_id, stream_id)` keys.

The following are receiver-specific:

- `webrtcbin`
- SDP negotiation state
- ICE state
- data channels
- data-channel open state
- branch cleanup

This replaces the previous single active receiver model based on `_active_receiver_id`.

### Multiple receivers

Each `receiver_joined` event creates independent branches for all registered streams and starts negotiation for that receiver only.

Each `receiver_left` event removes only that receiver's state and branches.

### Targeted SDP and ICE

Offers and sender ICE candidates now include:

```json
{
  "receiver_id": "browser_example",
  "stream_id": "camera1_image_raw"
}
```

Answers and receiver ICE candidates are matched using both receiver ID and stream ID, preventing candidates or SDP answers from being applied to another receiver's connection.

### Data channels

Timestamp and clock information is sent independently over each receiver's data channel.

A receiver's data-channel closure no longer removes another receiver's channel.

## Signaling Server Changes

`signaling/hub.go` now supports `receiver_id` in signaling messages.

The signaling server routes:

- Sender offers to the specific receiver identified by `receiver_id`.
- Sender ICE candidates to the specific receiver identified by `receiver_id`.
- Receiver answers to the sender identified by `sender_id`.
- Receiver ICE candidates to the sender identified by `sender_id`.

Offers and sender ICE candidates are no longer broadcast indiscriminately to every receiver. This is required because SDP and ICE state belong to one WebRTC peer connection.

The existing mDNS candidate replacement logic remains in place for browser ICE candidates.

## Browser Receiver Changes

`browser/webrtc.js` includes the browser's receiver ID in:

- SDP answers
- ICE candidates

The browser continues to maintain one `RTCPeerConnection` per stream for its connection to the sender.

## ROS 2 and Simulation Changes

`sender/ros2_bridge.py` now accepts a `simulate` argument.

`sender/main.py` passes the command-line `--simulate` value into `ROS2CameraBridge`.

Behavior is now explicit:

- Without `--simulate`, the bridge subscribes to ROS 2 `sensor_msgs/msg/Image` topics.
- With `--simulate`, the bridge generates synthetic camera frames even when ROS 2 is installed.

Previously, the `--simulate` flag was parsed but not passed into the bridge, which could make simulation behavior confusing.

## Local Run Commands

### Signaling server

```bash
go run . -port 8089 -browser ../browser
```

Health check:

```bash
curl http://localhost:8089/health
```

### Sender with a real ROS 2 topic

```bash
source /opt/ros/jazzy/setup.bash

python3 main.py \
  --codec vp8 \
  --topics /camera1/image_raw \
  --signaling ws://localhost:8089/
```

### Sender with synthetic frames

```bash

python3 main.py \
  --codec vp8 \
  --topics /camera1/image_raw \
  --simulate \
  --signaling ws://localhost:8089/
```

### Browser receiver

Open:

```text
http://localhost:8089
```

Click **Connect**. Multiple browser tabs or separate browsers can be used to test independent receivers.

## Diagnostics Covered

### No stream with successful ICE

A connection can show ICE `connected` or `completed` while the video is blank if the sender pipeline has stopped. The relevant diagnostic was:

```text
streaming stopped, reason not-linked (-1)
```

The permanent tee fallback branch fixes this condition.

### Camera topic not publishing

Use:

```bash
ros2 topic list -t
ros2 topic info /camera1/image_raw -v
ros2 topic hz /camera1/image_raw
```

The topic must have a publisher and must use:

```text
sensor_msgs/msg/Image
```

## Validation Performed

The following checks passed during implementation:

- Python compilation of the sender modules.
- GStreamer construction of the shared RTP tee pipeline.
- Frame pushes with zero receiver branches and no `NOT_LINKED` errors.
- Addition and removal of a receiver branch.
- Two-receiver isolation: removing receiver A leaves receiver B active.
- Repeated receiver branch add/remove cycles without GStreamer element-name collisions.
- Simulation flag propagation into the ROS 2 bridge.

## Expected Resource Behavior

Encoding cost stays approximately constant as receivers are added because each stream is encoded once.

Network upload still scales with the number of receivers:

$$
\text{total upload} \approx \text{encoded bitrate} \times \text{receiver count}
$$

Each receiver still consumes its own WebRTC, ICE, queue, UDP/TURN, and browser decoder resources.

A slow receiver is protected by its bounded leaky queue. It may drop old frames, but it should not block other receivers.

## Known Log Message During Disconnect

This message can appear while a browser receiver is closing:

```text
Could not write to resource.
SCTP association went into error state
```

When it occurs immediately after the data channel closes and the receiver leaves, while frame pushing continues with `err=0`, it is a WebRTC SCTP teardown race and not a media-path failure.

It requires further investigation only if it occurs while a receiver remains connected or is followed by ICE failure and stopped frame delivery.
