import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Html, Head, Preview, Body, Container, Section, Heading, Text, Button, Hr, } from '@react-email/components';
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
    fontSize: '14px',
    lineHeight: '22px',
    margin: '0 0 20px 0',
};
const buttonContainer = {
    textAlign: 'center',
    margin: '28px 0',
};
const actionButton = {
    backgroundColor: '#800000',
    borderRadius: '6px',
    color: '#ffffff',
    display: 'inline-block',
    fontSize: '14px',
    fontWeight: '600',
    padding: '12px 28px',
    textDecoration: 'none',
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
};
const linkNotice = {
    color: '#71717a',
    fontSize: '12px',
    lineHeight: '18px',
    wordBreak: 'break-all',
    margin: '16px 0 0 0',
};
const alertSection = {
    backgroundColor: '#fffbeb',
    borderRadius: '6px',
    border: '1px solid #fde68a',
    padding: '12px 16px',
    margin: '24px 0 0 0',
};
const alertTitle = {
    color: '#92400e',
    fontSize: '12px',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    margin: '0 0 4px 0',
};
const alertText = {
    color: '#78350f',
    fontSize: '12px',
    lineHeight: '18px',
    margin: '0',
};
const footerDivider = {
    borderColor: '#e4e4e7',
    margin: '28px 0 20px 0',
};
const footerText = {
    color: '#a1a1aa',
    fontSize: '12px',
    lineHeight: '18px',
    margin: '0',
    textAlign: 'center',
};
export function EmailChangeEmail({ currentEmail, newEmail, changeUrl, targetAddress, displayName, }) {
    const greeting = displayName ? `Hello ${displayName},` : 'Hello,';
    const isCurrent = targetAddress === 'current';
    return (_jsxs(Html, { lang: "en", children: [_jsx(Head, {}), _jsx(Preview, { children: "Confirm email address change for EARIST E-GatePass" }), _jsx(Body, { style: mainStyle, children: _jsxs(Container, { style: containerStyle, children: [_jsxs(Section, { style: headerSection, children: [_jsx(Heading, { style: headerTitle, children: "EARIST E-GatePass" }), _jsx(Text, { style: headerSubtitle, children: "Eulogio \"Amang\" Rodriguez Institute of Science and Technology" })] }), _jsx(Text, { style: greetingText, children: greeting }), _jsxs(Text, { style: bodyText, children: ["A request was submitted to change the email address on your EARIST E-GatePass account from", ' ', _jsx("strong", { children: currentEmail }), " to ", _jsx("strong", { children: newEmail }), ".", isCurrent
                                    ? ' Please confirm this change from your current email address to authorize the transition.'
                                    : ' Please verify this new email address to complete your account update.'] }), _jsx(Section, { style: buttonContainer, children: _jsx(Button, { style: actionButton, href: changeUrl, children: isCurrent ? 'Authorize Email Change' : 'Verify New Email Address' }) }), _jsxs(Text, { style: linkNotice, children: ["If the button above does not work, copy and paste this link into your browser:", _jsx("br", {}), changeUrl] }), _jsxs(Section, { style: alertSection, children: [_jsx(Text, { style: alertTitle, children: "Security Notice" }), _jsx(Text, { style: alertText, children: "If you did not request this email change, please do not click the link and report this immediately to the EARIST ICT / Campus Security Administration." })] }), _jsx(Hr, { style: footerDivider }), _jsxs(Text, { style: footerText, children: ["E-GatePass Campus Access Management System \u2022 Nagtahan, Sampaloc, Manila", _jsx("br", {}), "This is an automated institutional message. Please do not reply directly to this email."] })] }) })] }));
}
export default EmailChangeEmail;
