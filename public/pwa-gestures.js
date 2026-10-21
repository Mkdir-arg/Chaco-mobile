// Keep the app at its designed scale without interfering with one-finger scroll.
(function () {
  function preventZoom(event) { event.preventDefault(); }
  function preventPinch(event) {
    if (event.touches.length > 1) event.preventDefault();
  }
  document.addEventListener('touchstart', preventPinch, { passive: false });
  document.addEventListener('touchmove', preventPinch, { passive: false });
  // Safari can allow viewport zoom even when user-scalable is disabled.
  document.addEventListener('gesturestart', preventZoom, { passive: false });
  document.addEventListener('gesturechange', preventZoom, { passive: false });
  document.addEventListener('wheel', function (event) {
    if (event.ctrlKey) event.preventDefault();
  }, { passive: false });
}());
