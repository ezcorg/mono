#!/usr/bin/env python3
"""
Test script for the YouTube Data Interceptor addon.

This script provides basic tests to verify the addon functionality.
"""

import unittest
from unittest.mock import Mock, MagicMock
from youtube_interceptor import YouTubeInterceptor


class TestYouTubeInterceptor(unittest.TestCase):
    """Test cases for the YouTube interceptor addon."""

    def setUp(self):
        """Set up test fixtures."""
        self.interceptor = YouTubeInterceptor()

    def test_youtube_domain_detection(self):
        """Test YouTube domain detection."""
        # Test valid YouTube domains
        self.assertTrue(self.interceptor.is_youtube_domain('youtube.com'))
        self.assertTrue(self.interceptor.is_youtube_domain('www.youtube.com'))
        self.assertTrue(self.interceptor.is_youtube_domain('m.youtube.com'))
        self.assertTrue(
            self.interceptor.is_youtube_domain('music.youtube.com'))

        # Test case insensitive
        self.assertTrue(self.interceptor.is_youtube_domain('YOUTUBE.COM'))
        self.assertTrue(self.interceptor.is_youtube_domain('M.YouTube.Com'))

        # Test invalid domains
        self.assertFalse(self.interceptor.is_youtube_domain('google.com'))
        self.assertFalse(self.interceptor.is_youtube_domain('facebook.com'))
        self.assertFalse(self.interceptor.is_youtube_domain(''))
        self.assertFalse(self.interceptor.is_youtube_domain(None))

    def test_html_response_detection(self):
        """Test HTML response detection."""
        # Mock response with HTML content type
        html_response = Mock()
        html_response.headers = {'content-type': 'text/html; charset=utf-8'}
        self.assertTrue(self.interceptor.is_html_response(html_response))

        # Mock response with JSON content type
        json_response = Mock()
        json_response.headers = {'content-type': 'application/json'}
        self.assertFalse(self.interceptor.is_html_response(json_response))

        # Mock response with no content type
        no_type_response = Mock()
        no_type_response.headers = {}
        self.assertFalse(self.interceptor.is_html_response(no_type_response))

    def test_injection_script_content(self):
        """Test that injection script contains required elements."""
        script = self.interceptor.injection_script

        # Check for key components
        self.assertIn('window.ytInitialData', script)
        self.assertIn('console.log', script)
        self.assertIn('ytInitialDataCaptured', script)
        self.assertIn('_capturedYtInitialData', script)
        self.assertIn('DOMContentLoaded', script)
        self.assertIn('setTimeout', script)
        self.assertIn('setInterval', script)

    def test_addon_initialization(self):
        """Test addon initialization."""
        self.assertIsInstance(self.interceptor.youtube_domains, list)
        self.assertGreater(len(self.interceptor.youtube_domains), 0)
        self.assertIsInstance(self.interceptor.injection_script, str)
        self.assertGreater(len(self.interceptor.injection_script), 0)


def run_manual_test():
    """Run a manual test to verify the addon can be loaded."""
    print("Running manual test...")

    try:
        # Test addon instantiation
        interceptor = YouTubeInterceptor()
        print("✓ Addon instantiated successfully")

        # Test domain detection
        test_domains = [
            ('youtube.com', True),
            ('m.youtube.com', True),
            ('google.com', False),
            ('', False)
        ]

        for domain, expected in test_domains:
            result = interceptor.is_youtube_domain(domain)
            status = "✓" if result == expected else "✗"
            print(f"{status} Domain '{domain}': {result} (expected {expected})")

        # Test HTML detection
        mock_response = Mock()
        mock_response.headers = {'content-type': 'text/html'}
        result = interceptor.is_html_response(mock_response)
        status = "✓" if result else "✗"
        print(f"{status} HTML detection: {result}")

        # Test script content
        script_checks = [
            'window.ytInitialData',
            'console.log',
            'ytInitialDataCaptured'
        ]

        for check in script_checks:
            result = check in interceptor.injection_script
            status = "✓" if result else "✗"
            print(f"{status} Script contains '{check}': {result}")

        print("\nManual test completed!")

    except Exception as e:
        print(f"✗ Manual test failed: {e}")


if __name__ == "__main__":
    print("YouTube Data Interceptor - Test Suite")
    print("=" * 50)

    # Run unit tests
    print("\nRunning unit tests...")
    unittest.main(argv=[''], exit=False, verbosity=2)

    print("\n" + "=" * 50)

    # Run manual test
    run_manual_test()
