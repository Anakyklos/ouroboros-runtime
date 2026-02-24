import sys
import os
import resource
import signal
import json
import time
from datetime import datetime

# Disable buffering for immediate output
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

# Sandbox namespace
_ouroboros_sandbox_vars = {}

# Resource monitoring
_ouroboros_start_time = time.time()
_ouroboros_start_cpu = time.process_time()

def _ouroboros_get_resource_usage():
    """Get current resource usage"""
    try:
        import psutil
        process = psutil.Process()
        return {
            'memory_mb': process.memory_info().rss / 1024 / 1024,
            'cpu_time_ms': (time.process_time() - _ouroboros_start_cpu) * 1000
        }
    except ImportError:
        # Fallback if psutil not available
        return {
            'memory_mb': None,
            'cpu_time_ms': None
        }

def _ouroboros_enforce_limits(max_memory_mb, max_cpu_seconds, max_file_size_mb, max_processes):
    """Enforce CPU, memory, disk, and process limits"""
    try:
        # Set memory limit (if supported)
        if max_memory_mb:
            memory_limit = max_memory_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (memory_limit, memory_limit))
    except (ValueError, OSError):
        # Some systems don't support RLIMIT_AS
        pass

    try:
        # Set CPU time limit
        if max_cpu_seconds:
            cpu_limit = int(max_cpu_seconds)
            resource.setrlimit(resource.RLIMIT_CPU, (cpu_limit, cpu_limit))
    except (ValueError, OSError):
        pass

    try:
        # Set file size limit (disk limit)
        if max_file_size_mb:
            file_size_limit = max_file_size_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_FSIZE, (file_size_limit, file_size_limit))
    except (ValueError, OSError):
        pass

    try:
        # Set max processes limit
        if max_processes:
            resource.setrlimit(resource.RLIMIT_NPROC, (max_processes, max_processes))
    except (ValueError, OSError):
        pass

def _ouroboros_setup_signal_handlers():
    """Setup signal handlers for cleanup"""
    def timeout_handler(signum, frame):
        raise TimeoutError("Execution time limit exceeded")

    signal.signal(signal.SIGXCPU, timeout_handler)

print("__SANDBOX_INIT_COMPLETE__")
