import { useState } from 'react';

export default function useCameraPermissions() {
  const [permission, setPermission] = useState(null);
  const request = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({video:true,audio:false});
      stream.getTracks().forEach(track=>track.stop());
      const result = { granted:true, status:'granted', canAskAgain:true };
      setPermission(result); return result;
    } catch {
      const result = { granted:false, status:'denied', canAskAgain:true };
      setPermission(result); return result;
    }
  };
  return [permission, request];
}
