const { Router } = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const verifyZohoToken = require("../utils/verifyZohoToken");

const authRoutes = Router();

authRoutes.get("/zoho", (req, res) => {
  const redirectUrl = req.query.redirect || process.env.DEFAULT_FRONTEND_URL;
	const state = encodeURIComponent(JSON.stringify({ redirectUrl }));
	const authUrl = "https://accounts.zoho.com/oauth/v2/auth"+
    `?response_type=code` +
    `&client_id=${process.env.ZOHO_CLIENT_ID}` +
    `&scope=profile,email,ZOHOPEOPLE.forms.READ` +
    `&redirect_uri=${process.env.ZOHO_REDIRECT_URI}` +
    `&access_type=offline` +
    `&prompt=consent` +  // tweak: only enable to manually force the zoho oauth to send refresh token
    `&state=${state}`;
	res.redirect(authUrl);
});

authRoutes.get("/zoho/callback", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state ? JSON.parse(decodeURIComponent(req.query.state)) : {};
  const redirectUrl = state.redirectUrl || process.env.DEFAULT_FRONTEND_URL;

  try {  
    // Step 1: authorization code for access token
    const tokenResponse = await axios.post(
      "https://accounts.zoho.com/oauth/v2/token",
			new URLSearchParams({
        grant_type: "authorization_code",
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        redirect_uri: process.env.ZOHO_REDIRECT_URI,
        code,
			}),
			{
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
			}
		);

    // console.log("tokenResponse info ==> ", tokenResponse.data);    // debug
    const { access_token, refresh_token, id_token } = tokenResponse.data;
    const decodedJWT = jwt.decode(id_token);
    const userEmail = decodedJWT.email;
    
    if (!access_token) {
      throw new Error("Id token or Access Token not found");
    }

    if (!userEmail) {
      throw new Error("Email not found in decoded token");
    }

    // Fetch user details from Zoho People API by email
    const url = `https://people.zoho.com/api/forms/P_EmployeeView/records`;

    const peopleResponse = await axios.get(url, {
      headers: {
        Authorization: `Zoho-oauthtoken ${access_token}`,
      },
      params: {
        searchColumn: "EMPLOYEEMAILALIAS",
        searchValue: userEmail,
      },
    });

    // console.log("incoming data ===> ", peopleResponse.data);  // debug

    if (!peopleResponse.data || !Array.isArray(peopleResponse.data) || peopleResponse.data.length === 0) {
      throw new Error(`Failed to fetch user details from Zoho People API for email: ${userEmail}`);
    }

    // Extract user details
    const zohoUser = peopleResponse.data[0]; // the first record is the user
    const role = (zohoUser["Title"] || "").toLowerCase();
    const dept = (zohoUser["Department"] || "").toLowerCase();
    const status = (zohoUser["Employee Status"] || "").toLowerCase();
    const rmId = zohoUser["recordId"] || "";  // check

    // console.log(`data: ${role}, ${dept}, ${status}, ${rmId}`); // debug

    if (!(role === "relationship manager" || dept === "it desk") && status === "active") {
      throw new Error("User is NOT an RM or NOT an Active member");
    }

    console.log("User is an RM, store token details in frontend");

    res.cookie(
			"zoho_auth",
			{
				access_token,
				refresh_token,
				expiry: Date.now() + 3600 * 1000, // 1 hour
				rmId,
			},
			{
				httpOnly: true,
				secure: process.env.NODE_ENV === "production", // false on dev
				sameSite: "Lax",
				maxAge: 7 * 24 * 3600 * 1000, // 7 days
			}
		);
    
    return res.redirect(redirectUrl);
  } catch (error) {
    console.error("Error during authentication or fetching user details", error);
    return res.redirect(`${redirectUrl}/login?error=permissiondenied`);
  }
});

authRoutes.get("/zoho/getAccessToken", async (req, res) => {
  try {
    const cookie = req.cookies.zoho_auth;
    if (!cookie) return res.json({ isValid: false, isRM: false });

    let { access_token, refresh_token, expiry, rmId } = cookie;

    // Missing refresh token → cannot recover, force OAuth
    if (!refresh_token) {
      return res.json({ isValid: false, isRM: false });
    }

    // Refresh needed
    if (!access_token || Date.now() >= expiry) {
      const params = new URLSearchParams({
        refresh_token,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: "refresh_token",
      });

      const refreshRes = await axios.post(
        "https://accounts.zoho.com/oauth/v2/token",
        params
      );

      access_token = refreshRes.data.access_token;
      if (!access_token) return res.json({ isValid: false, isRM: false });
    }

    // VALIDATE USER FIRST
    const isValidRM = await verifyZohoToken(access_token, rmId);

    if (!isValidRM) {
      return res.json({ isValid: false, isRM: false });
    }

    // Now safe to update cookie (if refreshed)
    res.cookie(
      "zoho_auth",
      {
        access_token,
        refresh_token,
        expiry: Date.now() + 3600 * 1000, // 1 hour
        rmId,
      },
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "Lax",
        maxAge: 7 * 24 * 3600 * 1000, // refresh token lifetime
      }
    );

    return res.json({
      isValid: true,
      isRM: true,
      rmId,
    });

  } catch (err) {
    console.log("error in get-accessToken:", err);
    return res.json({ isValid: false, isRM: false });
  }
});

authRoutes.get("/zoho/logout", (req, res) => {
	res.clearCookie("zoho_auth", {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "Lax",
	});

	return res.json({
		success: true,
		message: "Logged out from Zoho",
	});
});

module.exports = authRoutes;