import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Html, Head, Preview, Body, Container, Section, Heading, Text, Hr, } from '@react-email/components';
const mainStyle = {
    backgroundColor: '#f4f4f5',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    margin: '0',
    padding: '24px 0',
};
const containerStyle = {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    border: '1px solid #e4e4e7',
    maxWidth: '560px',
    margin: '0 auto',
    padding: '32px 28px',
};
const headerSection = {
    borderBottom: '2px solid #800000',
    paddingBottom: '16px',
    marginBottom: '24px',
};
const headerTitle = {
    color: '#800000',
    fontSize: '24px',
    fontWeight: '700',
    letterSpacing: '-0.5px',
    margin: '0 0 4px 0',
};
const headerSubtitle = {
    color: '#71717a',
    fontSize: '13px',
    fontWeight: '500',
    margin: '0',
};
const greetingText = {
    color: '#18181b',
    fontSize: '16px',
    margin: '0 0 16px 0',
};
const bodyText = {
    color: '#3f3f46',
    fontSize: '15px',
    lineHeight: '1.5',
    margin: '0 0 20px 0',
};
const cardSection = {
    backgroundColor: '#fafafa',
    border: '1px solid #e4e4e7',
    borderRadius: '8px',
    padding: '16px 20px',
    margin: '20px 0',
};
const detailRow = {
    color: '#27272a',
    fontSize: '14px',
    lineHeight: '1.6',
    margin: '4px 0',
};
const noticeSection = {
    backgroundColor: '#fffbeb',
    border: '1px solid #fef3c7',
    borderRadius: '8px',
    padding: '14px 18px',
    margin: '20px 0',
};
const noticeText = {
    color: '#92400e',
    fontSize: '13px',
    lineHeight: '1.5',
    margin: '0',
};
const hrStyle = {
    borderColor: '#e4e4e7',
    margin: '24px 0 16px 0',
};
const footerText = {
    color: '#a1a1aa',
    fontSize: '12px',
    lineHeight: '1.4',
    margin: '0',
    textAlign: 'center',
};
export function PassIssuedEmail({ fullName, visitDate, purpose, publicReference, validFrom, validUntil, }) {
    return (_jsxs(Html, { lang: "en", children: [_jsx(Head, {}), _jsxs(Preview, { children: ["Your EARIST Gate Pass QR Code \u2014 Ref: ", publicReference] }), _jsx(Body, { style: mainStyle, children: _jsxs(Container, { style: containerStyle, children: [_jsxs(Section, { style: headerSection, children: [_jsx(Heading, { style: headerTitle, children: "EARIST E-GatePass" }), _jsx(Text, { style: headerSubtitle, children: "Official Campus Visitor Gate Pass" })] }), _jsxs(Section, { children: [_jsxs(Text, { style: greetingText, children: ["Hello ", _jsx("strong", { children: fullName }), ","] }), _jsxs(Text, { style: bodyText, children: ["Your campus visitor pass has been issued. Your scannable entry QR code is attached to this email as an image file (", _jsx("code", { children: "earist-gate-pass-qr.png" }), ")."] }), _jsxs(Section, { style: cardSection, children: [_jsxs(Text, { style: detailRow, children: [_jsx("strong", { children: "Visitor Name:" }), " ", fullName] }), _jsxs(Text, { style: detailRow, children: [_jsx("strong", { children: "Pass Reference:" }), " ", publicReference] }), _jsxs(Text, { style: detailRow, children: [_jsx("strong", { children: "Visit Date:" }), " ", visitDate] }), validFrom && validUntil && (_jsxs(Text, { style: detailRow, children: [_jsx("strong", { children: "Valid Hours:" }), " ", validFrom, " \u2013 ", validUntil, " (Asia/Manila)"] })), _jsxs(Text, { style: detailRow, children: [_jsx("strong", { children: "Purpose:" }), " ", purpose] })] }), _jsx(Section, { style: noticeSection, children: _jsxs(Text, { style: noticeText, children: [_jsx("strong", { children: "Security Notice:" }), " Present the attached QR code at the entrance scanner upon arrival. You must present the same valid government or school ID used during registration."] }) })] }), _jsx(Hr, { style: hrStyle }), _jsx(Section, { children: _jsx(Text, { style: footerText, children: "EARIST Manila Campus \u2022 Nagtahan, Sampaloc, Manila \u2022 Automated Gate Pass Notification" }) })] }) })] }));
}
export default PassIssuedEmail;
