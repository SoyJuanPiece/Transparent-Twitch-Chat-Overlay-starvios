
namespace TransparentTwitchChatWPF
{
    public enum ChatTypes
    {
        NativeChat = 0,
        TwitchPopout = 1,
        KapChat = 2,
        CustomURL = 3,
        StarviosNative = 4,
    }

    public static class ChatTypeExtensions
    {
        /// <summary>True for chat types rendered by the NativeChat v2 engine (Twitch or Starvios source).</summary>
        public static bool UsesNativeChat(int chatType) =>
            chatType == (int)ChatTypes.NativeChat || chatType == (int)ChatTypes.StarviosNative;
    }
}