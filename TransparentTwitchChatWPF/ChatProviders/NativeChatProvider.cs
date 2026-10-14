using Microsoft.Web.WebView2.Core;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using TransparentTwitchChatWPF.Helpers;
using TransparentTwitchChatWPF.Properties;

namespace TransparentTwitchChatWPF.ChatProviders;

public class NativeChatProvider : IChatProvider
{
    private readonly string _source;

    /// <param name="source">Chat source for the NativeChat v2 engine: "twitch" (IRC, default) or "starvios".</param>
    public NativeChatProvider(string source = "twitch")
    {
        _source = string.IsNullOrWhiteSpace(source) ? "twitch" : source;
    }

    /// <summary>Turns "https://starvios.com/live/JuanPiece/", "@juanpiece" or "juanpiece" into "juanpiece".</summary>
    public static string NormalizeStarviosChannel(string input)
    {
        string s = (input ?? string.Empty).Trim();
        s = s.Split('?', '#')[0].TrimEnd('/');
        int slash = s.LastIndexOf('/');
        if (slash >= 0) s = s.Substring(slash + 1);
        return s.Trim().TrimStart('@');
    }

    public Uri GetNavigationUri()
    {
        string hostName = OverlayPathHelper.GetNativeChatHostname();
        return new Uri($"https://{hostName}/v2/index.html");
    }

    public Task ConfigureAsync(CoreWebView2 coreWebView2)
    {
        SyncChannelSettings();

        // Set on every connect: the appearance page replaces jChatSettings from its own JSON,
        // which does not carry the source, so it must be restored here.
        App.Settings.jChatSettings.Source = _source;
        if (_source == "starvios")
        {
            App.Settings.jChatSettings.Channel = NormalizeStarviosChannel(App.Settings.GeneralSettings.StarviosChannel);
        }

        PostWebMessage(coreWebView2, "config", App.Settings.jChatSettings);
        PostWebMessage(coreWebView2, "credentials", new
        {
            ClientId = "yv4bdnndvd4gwsfw7jnfixp0mnofn7",
            Token = App.Settings.GeneralSettings.OAuthToken
        });

        return Task.CompletedTask;
    }

    // --- Helper methods --------------------------
    private void SyncChannelSettings()
    {
        if (App.Settings?.jChatSettings == null || App.Settings?.GeneralSettings == null)
        {
            // Settings failed to load — bail out gracefully or initialize defaults
            throw new InvalidOperationException(
                "App.Settings or its sub-settings are null. Settings may have failed to load from disk.");
        }

        if (string.IsNullOrEmpty(App.Settings.jChatSettings.Channel))
        {
            App.Settings.jChatSettings.Channel = !string.IsNullOrEmpty(App.Settings.GeneralSettings.Username)
                ? App.Settings.GeneralSettings.Username
                : string.Empty;
        }

        App.Settings.SyncJChatSettings();
    }

    private void PostWebMessage(CoreWebView2 coreWebView2, string type, object payload)
    {
        var options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        };

        var message = new { Type = type, Payload = payload };
        coreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message, options));
    }
}
