<?php
/**
 * Minimal integration example. Replace $friendId with the open chat user's ID.
 * The existing INK call overlay can listen to these events and keep its own CSS.
 */
$friendId = isset($friend_id) ? (int) $friend_id : 0;
?>
<button type="button" id="inkVoiceCall">Voice call</button>
<button type="button" id="inkVideoCall">Video call</button>
<button type="button" id="inkAcceptCall" hidden>Accept</button>
<button type="button" id="inkDeclineCall" hidden>Decline</button>
<button type="button" id="inkEndCall" hidden>End</button>
<video id="inkRemoteVideo" autoplay playsinline></video>
<video id="inkLocalVideo" autoplay playsinline muted></video>

<script type="module">
import { InkWebRtcClient } from "/assets/js/ink-webrtc-client.js";

const calls = new InkWebRtcClient({ tokenEndpoint: "/call_token.php" });
const friendId = <?= json_encode($friendId) ?>;
const remoteVideo = document.getElementById("inkRemoteVideo");
const localVideo = document.getElementById("inkLocalVideo");
const accept = document.getElementById("inkAcceptCall");
const decline = document.getElementById("inkDeclineCall");
const end = document.getElementById("inkEndCall");

calls.addEventListener("localstream", ({ detail }) => {
  localVideo.srcObject = detail.stream;
});
calls.addEventListener("remotestream", ({ detail }) => {
  remoteVideo.srcObject = detail.stream;
});
calls.addEventListener("incoming", ({ detail }) => {
  accept.hidden = false;
  decline.hidden = false;
  window.dispatchEvent(new CustomEvent("ink:incoming-call", { detail }));
});
calls.addEventListener("accepted", () => {
  accept.hidden = true;
  decline.hidden = true;
  end.hidden = false;
});
calls.addEventListener("ended", () => {
  accept.hidden = decline.hidden = end.hidden = true;
});

document.getElementById("inkVoiceCall").onclick = () => calls.startCall(friendId, "audio");
document.getElementById("inkVideoCall").onclick = () => calls.startCall(friendId, "video");
accept.onclick = () => calls.acceptCall();
decline.onclick = () => calls.declineCall();
end.onclick = () => calls.endCall();

calls.connect().catch((error) => console.error("Calling unavailable", error));
</script>

