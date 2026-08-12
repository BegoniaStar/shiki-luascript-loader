-- SPDX-License-Identifier: AGPL-3.0-only
-- Original small-script fixture for message delivery, formatting, and replies.

msg_order = {
    [".smdeck"] = function(msg)
        return drawDeck(msg.gid, msg.uid, "review-deck")
    end,
    [".smqueue"] = function(msg)
        sendMsg("queued:" .. msg.uid, msg.gid)
        return "queue-complete"
    end,
    [".smprivate"] = function(msg)
        sendMsg("private:" .. msg.uid, 0, msg.uid)
    end,
    [".smformat"] = function(msg)
        msg:echo("format-me")
        msg:echo("raw-me", true)
        return "format-complete"
    end,
    [".smplain"] = { echo = "plain-reply" },
    [".smsandbox"] = function(msg)
        return tostring(io) .. "," .. tostring(os) .. "," .. tostring(package)
            .. "," .. tostring(dofile) .. "," .. tostring(loadfile)
    end,
    [".smburst"] = function(msg)
        for i = 1, 5 do msg:echo("burst-" .. i) end
        return "burst-complete"
    end,
}

msg_reply = {
    exact = {
        keyword = { Match = "watch ping" },
        echo = function(msg) return "exact:" .. msg.uid end,
    },
    prefix = {
        keyword = { Prefix = "watch signal " },
        type = "Both",
        echo = function(msg) return "prefix:" .. msg.suffix end,
    },
    search = {
        keyword = { Search = "watch find" },
        echo = "search-hit",
    },
    regex = {
        keyword = { Regex = "^watch-[0-9]+$" },
        echo = "regex-hit",
    },
    restricted = {
        keyword = { Match = "watch secret" },
        limit = { user_id = { "6401" }, grp_id = { "9001" }, prob = 90 },
        echo = "restricted-hit",
    },
}
