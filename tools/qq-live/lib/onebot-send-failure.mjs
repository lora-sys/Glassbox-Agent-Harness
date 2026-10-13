/** Classify the bounded NapCat send rejection without retaining provider error text. */
export function classifyOneBotSendFailure(action, response) {
  if (
    !["send_private_msg", "send_group_msg"].includes(action) ||
    response?.status !== "failed" ||
    response.retcode !== 1200 ||
    typeof response.message !== "string" ||
    Buffer.byteLength(response.message, "utf8") > 4096 ||
    (response.wording !== undefined && response.wording !== response.message)
  )
    return undefined;
  const prefix =
    "EventChecker Failed: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg ListenerName:NodeIKernelMsgListener/onMsgInfoListUpdate EventRet:\n";
  if (!response.message.startsWith(prefix)) return undefined;
  let result;
  try {
    result = JSON.parse(response.message.slice(prefix.length));
  } catch {
    return undefined;
  }
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).sort().join(",") !== "errMsg,result" ||
    result.result !== -10003 ||
    typeof result.errMsg !== "string" ||
    !/(?:请|需要|必须|要求)重新登录/u.test(result.errMsg) ||
    /(?:无需|不需要|不必|不要|请勿|禁止)重新登录/u.test(result.errMsg)
  )
    return undefined;
  return {
    kind: "ACCOUNT_REAUTH_REQUIRED",
    providerResult: -10003,
    message: "QQ 发送接口要求重新登录，内部 result=-10003。",
  };
}
