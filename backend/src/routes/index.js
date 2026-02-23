const axios = require("axios");
const { Router } = require("express");
const { submitLeadToCRM } = require("../utils/submitLeadToCRM");
const multer = require("multer");
const otpRoutes = require("./otpRoutes");
const InsuranceForm = require("../database/models/InsuranceForm");
const jwt = require("jsonwebtoken");
const verifyJWT = require("../middleware/verifyToken");
const { WA_WATI_THANK_YOU_TEMPLATE_URL } = require("../utils/constants");
// const Lead = require("../database/models/Lead");

const router = Router();
const upload = multer();

// OTP routes
router.use("/otp", otpRoutes);

// Lead Submission API
router.post("/submit-lead", verifyJWT, upload.single("file"),	async (req, res) => {
		try {
			const leadId = await submitLeadToCRM({
				contactNumber: req.contactNumber,
				name: req.body.name,
				leadId: req.body?.leadId,
				isRM: req.body?.isRM,
				cookie: req.body.isRM ? req.cookies.zoho_auth : "",
				ReferralSource: req.body?.entryType,
				uploadedFile: req.file,
			});
			res.status(200).json({ success: true, leadId });

		} catch (err) {
			console.error("Submit lead error:", err);
			res.status(500).json({ error: err.message || "Internal Server Error" });
		}
	}
);

// Data storage API
router.post("/insurance-form", verifyJWT, async (req, res) => {
	try {
		const contactNumber = req.contactNumber;
		const { currentStep, progress, isOpened, entryType, ...storedData } = req.body;

		// Fetch existing doc first
		const existingDoc = await InsuranceForm.findOne({ contactNumber });
		// const existingLead = await Lead.findOne({ phone: contactNumber });
		
		// Determine correct progress
		let finalProgress = progress;
		if (existingDoc && typeof existingDoc.progress === "number") {
			finalProgress = Math.max(existingDoc.progress, progress);
		}

		const updateObj = {
			...storedData,
			currentStep,
			entryType,
			progress: finalProgress,
		};

		// console.log("Document info:-- ", updateObj); 	// debug
		
		// if (!existingDoc && typeof isOpened !== "undefined") {		// older code
		if (!existingDoc) {
			updateObj.isOpened = isOpened;
			updateObj.contactNumber = contactNumber;
		}

		const formRes = await InsuranceForm.findOneAndUpdate(
			{ contactNumber },
			{ $set: updateObj },
			{ new: true, upsert: true }
		);

		// const responseData = { success: true };
		// if (leadDetails) {
		// 	responseData.leadDetails = leadDetails;
		// }
		// console.log(`Form Data updated successfully for contact number: ${contactNumber}.\n`, updatedDoc); // debug
		// res.json({ success: true, data: updatedDoc });  // Not sending the data back to FE
		if (formRes) {
			res.json({ success: true });
		}
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

// Fetch Insurance Form Data
router.get("/insurance-form", verifyJWT, async (req, res) => {
	try {
		const { contactNumber } = req.contactNumber;
		const form = await InsuranceForm.findOne({ contactNumber });
		if (!form) {
			return res.status(404).json({ success: false, message: "No form found" });
		}
		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ success: false, error: "Server error" });
	}
});

// Generate JWT Token for leadless clean form submission
router.post("/generate-jwt", async (req, res) => {
	try {
		const contactNumber = req.body.contactNumber;
		if (!contactNumber) {
			res.status(400).json({ error: "Contact number not found in request." });
			return;
		}
		
		const token = jwt.sign({ contactNumber }, process.env.JWT_SECRET, {		// To-Do: SET SECRET in .env
			expiresIn: "10d",
		});
		res.status(200).json({ token });
	} catch (err) {
		console.error("Problem in generate-jwt API");
		res.status(500).json({ message: "Internal Server Error." });
	}
})

// Thank You Confirmation after review page is loaded
router.post("/thank-you", verifyJWT, async (req, res) => {
	try {
		const broadcastChannelName = process.env.WA_BROADCAST_CHANNEL;
		const contactNumber = req.contactNumber;
		const insurerName = req.body.selfName;

		const payload = {
			template_name: "health_insurance004",
			broadcast_name: broadcastChannelName,
			receivers: [
				{
					whatsappNumber: contactNumber,
					customParams: [{ name: "name", value: insurerName }],
				},
			],
		};

		const headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${process.env.WA_TOKEN}`,
		};

		// Check for Message sent flag if already sent (messages are sent only once):
		const formRes = await InsuranceForm.findOne({ contactNumber });
		if (formRes?.thankyouMessageSent) {
			return res.status(200).json({ message: "Already sent" });
		}

		// Send to WATI
		const response = await axios.post(WA_WATI_THANK_YOU_TEMPLATE_URL, payload, {
			headers,
		});

		if (!response.data.result) {
			console.error(`Error while sending thank you message to ${contactNumber}`);
			return res.status(500).json({ message: "Error sending confirmation message to WhatsApp." });
		}

		// Update the DB field
		await InsuranceForm.findOneAndUpdate(
			{ contactNumber },
			{ $set: { thankyouMessageSent: true } },
			{ new: true, upsert: true }
		);

		res.status(200).json({ message: "Thank you sent" });
	} catch (err) {
		console.error("Unable to Send Thank You Confirmation message.", err);
		res.status(500).json({ message: "Internal Server Error" });
	}
});


module.exports = router;