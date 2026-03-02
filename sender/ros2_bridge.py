"""
ROS2 Bridge: Subscribes to multiple image topics and feeds frames
to corresponding GStreamer pipelines.
"""

import time
import logging
import numpy as np
from typing import Dict, Callable, Optional

logger = logging.getLogger(__name__)

try:
    import rclpy
    from rclpy.node import Node
    from sensor_msgs.msg import Image, CompressedImage
    ROS2_AVAILABLE = True

except ImportError:
    ROS2_AVAILABLE = False
    logger.warning("ROS2 not available. Using simulated camera feeds.")


class ROS2CameraBridge:
    """Bridges ROS2 image topics to GStreamer pipelines."""

    def __init__(self, topics: list, width: int = 640, height: int = 480):
        self.topics = topics
        self.width = width
        self.height = height
        self.frame_callbacks: Dict[str, Callable] = {}
        self._node = None
        self._spin_thread = None

    def register_callback(self, topic: str, callback: Callable):
        """Register a callback for when a frame arrives on a topic."""
        self.frame_callbacks[topic] = callback

    def start(self):
        """Start subscribing to ROS2 topics."""
        if ROS2_AVAILABLE:
            self._start_ros2()
        else:
            logger.info("Starting simulated camera feeds")
            self._start_simulated()

    def _start_ros2(self):
        """Start actual ROS2 subscriptions + spin thread."""
        if not rclpy.ok():
            rclpy.init()

        self._node = rclpy.create_node('webrtc_camera_bridge')

        for topic in self.topics:
            # Create subscription for each topic
            self._node.create_subscription(
                Image,
                topic,
                lambda msg, t=topic: self._on_image(msg, t),
                10
            )
            logger.info(f"Subscribed to ROS2 topic: {topic}")

        # Spin in background thread so callbacks fire
        import threading
        self._spin_thread = threading.Thread(
            target=self._spin_loop,
            daemon=True
        )
        self._spin_thread.start()
        logger.info("ROS2 spin thread started")

    def _spin_loop(self):
        """Spin the ROS2 node continuously in a background thread."""
        try:
            rclpy.spin(self._node)
        except Exception as e:
            logger.error(f"ROS2 spin error: {e}")

    def _on_image(self, msg, topic: str):
        """Handle incoming ROS2 Image message."""
        capture_ts = time.monotonic_ns()

        try:
            # Always use manual numpy conversion — cv_bridge is unreliable
            # with NumPy 2.x (segfaults due to _ARRAY_API incompatibility).
            img_array = np.frombuffer(msg.data, dtype=np.uint8)

            if msg.encoding == 'rgb8':
                cv_image = img_array.reshape((msg.height, msg.width, 3))
            elif msg.encoding == 'bgr8':
                cv_image = img_array.reshape((msg.height, msg.width, 3))
                cv_image = cv_image[:, :, ::-1].copy()  # BGR → RGB
            elif msg.encoding in ('mono8', '8UC1'):
                gray = img_array.reshape((msg.height, msg.width))
                cv_image = np.stack([gray, gray, gray], axis=-1)
            elif msg.encoding == 'rgba8':
                cv_image = img_array.reshape((msg.height, msg.width, 4))[:, :, :3].copy()
            elif msg.encoding == 'bgra8':
                bgra = img_array.reshape((msg.height, msg.width, 4))
                cv_image = bgra[:, :, 2::-1].copy()  # BGRA → RGB
            else:
                logger.warning(f"Unsupported encoding '{msg.encoding}', treating as RGB")
                cv_image = img_array.reshape((msg.height, msg.width, 3))

            # Resize if needed
            if cv_image.shape[1] != self.width or cv_image.shape[0] != self.height:
                import cv2
                cv_image = cv2.resize(cv_image, (self.width, self.height))

            # Ensure contiguous memory for GStreamer
            frame_bytes = np.ascontiguousarray(cv_image).tobytes()

            if topic in self.frame_callbacks:
                self.frame_callbacks[topic](frame_bytes, capture_ts)

        except Exception as e:
            logger.error(f"Error processing image from {topic}: {e}")

    def _start_simulated(self):
        """Start simulated camera feeds for testing without ROS2."""
        import threading

        for topic in self.topics:
            t = threading.Thread(
                target=self._simulate_camera,
                args=(topic,),
                daemon=True
            )
            t.start()

    def _simulate_camera(self, topic: str, fps: int = 30):
        """Generate synthetic test frames."""
        frame_num = 0
        interval = 1.0 / fps

        # Generate a colored gradient that varies per topic
        topic_hash = hash(topic) % 256
        logger.info(f"Simulating camera feed for topic: {topic} (color offset: {topic_hash})")

        while True:
            capture_ts = time.monotonic_ns()

            # Create a test pattern frame (RGB)
            frame = np.zeros((self.height, self.width, 3), dtype=np.uint8)

            # Scrolling gradient with topic-specific color
            y_coords = np.arange(self.height).reshape(-1, 1)
            x_coords = np.arange(self.width).reshape(1, -1)

            frame[:, :, 0] = ((x_coords + frame_num * 2 + topic_hash) % 256).astype(np.uint8)
            frame[:, :, 1] = ((y_coords + frame_num) % 256).astype(np.uint8)
            frame[:, :, 2] = ((x_coords + y_coords + topic_hash * 2) % 256).astype(np.uint8)

            # Add frame counter marker (white block in top-left that blinks)
            block_size = 20
            if frame_num % 30 < 15:
                frame[5:5+block_size, 5:5+block_size, :] = 255

            frame_bytes = frame.tobytes()

            if topic in self.frame_callbacks:
                self.frame_callbacks[topic](frame_bytes, capture_ts)

            frame_num += 1
            time.sleep(interval)

    def spin(self):
        """Spin the ROS2 node (blocking)."""
        if ROS2_AVAILABLE and self._node:
            rclpy.spin(self._node)

    def shutdown(self):
        """Clean shutdown."""
        if ROS2_AVAILABLE and self._node:
            self._node.destroy_node()
            rclpy.shutdown()