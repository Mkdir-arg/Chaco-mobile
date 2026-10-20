import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

// Bundle the decoder: no CDN/script request, including when starting offline.
const PlatformCamera = forwardRef(({ active, onCameraReady, onMountError, onBarcodeScanned }, ref) => {
  const video = useRef(null);
  const onScan = useRef(onBarcodeScanned);
  onScan.current = onBarcodeScanned;
  useImperativeHandle(ref, () => ({
    takePictureAsync: async ({ quality = 0.78 } = {}) => {
      const element = video.current;
      if (!element?.videoWidth) throw new Error('La cámara todavía no está lista.');
      const canvas = document.createElement('canvas');
      canvas.width = element.videoWidth; canvas.height = element.videoHeight;
      canvas.getContext('2d').drawImage(element, 0, 0);
      return { uri: canvas.toDataURL('image/jpeg', quality), width: canvas.width,
        height: canvas.height, mimeType: 'image/jpeg', fileName: `foto_${Date.now()}.jpg` };
    },
  }));
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false, stream, controls;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
        if (cancelled) { stream.getTracks().forEach(track=>track.stop()); return; }
        const element = video.current;
        element.srcObject = stream;
        await element.play();
        if (cancelled) return;
        onCameraReady?.();
        if (onScan.current) {
          const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE, BarcodeFormat.PDF_417]]]);
          controls = await new BrowserMultiFormatReader(hints, {delayBetweenScanAttempts:250})
            .decodeFromStream(stream, element, result => {
              if (!cancelled && result && onScan.current) onScan.current({
                data: result.getText(), type: result.getBarcodeFormat() === BarcodeFormat.PDF_417 ? 'pdf417' : 'qr',
              });
            });
          if (cancelled) controls.stop();
        }
      } catch (error) {
        stream?.getTracks().forEach(track=>track.stop());
        if (!cancelled) onMountError?.({message:error.message});
      }
    })();
    return () => { cancelled=true; controls?.stop(); stream?.getTracks().forEach(track=>track.stop()); };
  }, [active]);
  return <video ref={video} playsInline muted aria-label="Cámara de documentación"
    style={{width:'100%',height:'100%',objectFit:'cover'}} />;
});
export default PlatformCamera;
